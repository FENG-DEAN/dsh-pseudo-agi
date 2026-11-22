/**
 * Consciousness scaffold.
 *
 * The model *is* the consciousness; this plugin is the part of its environment it
 * cannot write for itself. Concretely it does two things and refuses to do a third:
 *
 * - **injects** one discipline message at the first step of each turn, through the
 *   `agent/pre-step` waterfall (a model cannot edit its own prompt);
 * - **records** that it did so, on the event bus, so governance has a durable trace;
 * - **never routes**: it does not read the prompt to guess "recall or act", does
 *   not pick tools, and cannot veto the loop's decision (it awaits `next()` first
 *   and only appends).
 *
 * Why a message and not `agent.inject()`: the pre-step waterfall decides what
 * enters the step, so the discipline lands in the same decision, before the
 * request, and is logged with the step it belongs to.
 *
 * @module @pseudo-agi/scaffold
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { Config, disciplineText, validateConfig } from './config.js'
import type { ScaffoldConfig } from './config.js'
import type { PseudoAgiScaffoldStepEvent } from './events.js'

export { Config }
export type { ScaffoldConfig }
export type { PseudoAgiScaffoldStepEvent }
export { disciplineText }

/** Plugin name. */
export const name = 'pseudo-agi-scaffold'

/**
 * No service dependency: the scaffold reads nothing from the tool registry or
 * the prompt registry. That is the point — it can load in any composition,
 * including one where tools are absent.
 */
export const inject: string[] = []

/** Per-turn injection bookkeeping, reclaimed with the agent object. */
interface TurnState {
  turn: number
  injected: number
}

/**
 * Install the scaffold.
 * @param ctx - plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: ScaffoldConfig): void {
  validateConfig(config)
  if (!config.enabled) return

  const states = new WeakMap<Agent, TurnState>()
  const stateOf = (agent: Agent): TurnState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const created: TurnState = { turn: -1, injected: 0 }
    states.set(agent, created)
    return created
  }

  const emitStep = (payload: PseudoAgiScaffoldStepEvent): void => {
    ctx.emit('pseudo-agi/scaffold-step', payload)
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    // The loop's own decision comes first; the scaffold never overrides it.
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    try {
      const state = stateOf(payload.agent)
      if (state.turn !== payload.turn) {
        state.turn = payload.turn
        state.injected = 0
      }
      // A retried or resumed step may still carry the discipline from its first
      // admission: inject at most once per step and at most N times per turn.
      const alreadyInjected = decision.messages.some(
        message => message.source.kind === 'pseudo-agi-scaffold',
      )
      const canInject = !alreadyInjected && state.injected < config.injectPerTurn
      emitStep({
        sessionId: String(payload.agent.id),
        turn: payload.turn,
        step: payload.step,
        injected: canInject,
        at: new Date().toISOString(),
      })
      if (!canInject) return decision

      state.injected++
      const message = createUserMessage({
        content: [{ type: 'text', text: disciplineText(config) }],
        source: {
          kind: 'pseudo-agi-scaffold',
          form: 'notice',
          summary: '本轮纪律注入',
        },
      })
      return {
        kind: 'enter',
        messages: [...decision.messages, message],
        ...(decision.startsRequestSeries === true ? { startsRequestSeries: true as const } : {}),
      }
    } catch (error) {
      // A scaffold that fails must never fail the step.
      ctx.logger.warn(`pseudo-agi-scaffold: injection failed: ${String(error)}`)
      return decision
    }
  })
}
