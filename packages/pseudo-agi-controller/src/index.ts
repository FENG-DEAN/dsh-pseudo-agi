/**
 * Routing controller plugin.
 *
 * It does not own the agent loop, does not answer, and does not judge whether
 * the answer is correct. It sits on `agent/pre-step`, inspects the messages the
 * loop is about to admit, picks a route, and appends ONE bounded directive
 * message to that step. That is the whole "consciousness": a policy injection
 * at the machine's own extension point, visible in the session log, revocable
 * by unloading the plugin.
 *
 * Why a message and not `agent.inject()`: the pre-step waterfall decides what
 * enters the step, so the directive is part of the same decision, ordered before
 * the request, and logged with the step it belongs to. `steer()` is reserved for
 * the one reflective turn-boundary case below.
 *
 * @module @pseudo-agi/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

import { Config, validateConfig } from './config.js'
import type { ControllerConfig } from './config.js'
import { decideRoute, directiveText, lastUserText } from './router.js'
import type { PseudoAgiControllerDecisionEvent } from './events.js'

export { Config }
export type { ControllerConfig }
export type { Route, RouteDecision } from './router.js'
export type { PseudoAgiControllerDecisionEvent }
export { decideRoute, directiveText, lastUserText }

/** Tools whose success or failure tells the controller whether evidence exists. */
const RECALL_TOOLS: ReadonlySet<string> = new Set(['memory_recall', 'kb_search'])

/** Tools that can change the world, and therefore need approval. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['controlled_write'])

/** One-line reflection used at the turn boundary. */
const REFLECTION = [
  '本轮检索没有命中。收尾时请明确声明“没有找到相关记忆/文档”，',
  '不要用训练知识补全，也不要把没有证据的推断写成事实。',
].join('')

/** Plugin name. */
export const name = 'pseudo-agi-controller'

/** Needs the tool registry to know which capabilities this agent actually has. */
export const inject = ['tools']

/** Per-agent controller state, reclaimed with the agent object. */
interface AgentState {
  turn: number
  injected: number
  reflected: boolean
  emptyRecall: boolean
}

/**
 * Install the routing controller.
 * @param ctx - plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: ControllerConfig): void {
  validateConfig(config)
  if (!config.enabled) return

  const states = new WeakMap<Agent, AgentState>()
  const stateOf = (agent: Agent): AgentState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const created: AgentState = { turn: -1, injected: 0, reflected: false, emptyRecall: false }
    states.set(agent, created)
    return created
  }

  const emitDecision = (payload: PseudoAgiControllerDecisionEvent): void => {
    ctx.emit('pseudo-agi/controller-decision', payload)
  }

  // Observe recall results so the turn-boundary reflection knows whether the
  // turn ended without evidence. Read-only: no result is changed here.
  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined || !RECALL_TOOLS.has(exec.name) || result.isError) return undefined
    const value = result.value
    if (typeof value === 'object' && value !== null && (value as { found?: unknown }).found === false) {
      stateOf(agent).emptyRecall = true
    }
    return undefined
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    // The loop's own decision comes first; the controller only appends to it.
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    try {
      const state = stateOf(payload.agent)
      if (state.turn !== payload.turn) {
        state.turn = payload.turn
        state.injected = 0
        state.reflected = false
        state.emptyRecall = false
      }

      const names = new Set(ctx.tools.definitions(payload.agent).map(definition => definition.name))
      const route = decideRoute({
        text: lastUserText(decision.messages),
        hasRecallTool: [...RECALL_TOOLS].some(tool => names.has(tool)),
        hasWriteTool: [...WRITE_TOOLS].some(tool => names.has(tool)),
        requireEvidence: config.requireEvidence,
        recallKeywords: config.recallKeywords,
        writeKeywords: config.writeKeywords,
        minPromptChars: config.minPromptChars,
      })

      // A resumed/retried step may still carry the directive from its first
      // admission: inject at most once per step, and at most N times per turn.
      const alreadyInjected = decision.messages.some(message => message.source.kind === 'pseudo-agi-controller')
      const canInject = !alreadyInjected && state.injected < config.injectPerTurn
      const base: PseudoAgiControllerDecisionEvent = {
        sessionId: String(payload.agent.id),
        turn: payload.turn,
        step: payload.step,
        route: route.route,
        reason: route.reason,
        injected: canInject,
        at: new Date().toISOString(),
      }
      if (!canInject) {
        emitDecision(base)
        return decision
      }

      state.injected++
      const message = createUserMessage({
        content: [{ type: 'text', text: directiveText(route) }],
        source: {
          kind: 'pseudo-agi-controller',
          form: 'notice',
          summary: `路由 ${route.route}：${route.reason}`.slice(0, 120),
        },
      })
      emitDecision(base)
      return {
        kind: 'enter',
        messages: [...decision.messages, message],
        ...(decision.startsRequestSeries === true ? { startsRequestSeries: true as const } : {}),
      }
    } catch (error) {
      // Routing is an enhancement: never fail a step because it could not run.
      ctx.logger.warn(`pseudo-agi-controller: routing failed: ${String(error)}`)
      return decision
    }
  })

  // One bounded reflection per turn, only when a recall came back empty. Off by
  // default: steering here re-opens the turn, so this is opt-in.
  ctx.on('agent/turn-stopping', (payload) => {
    if (!config.reflectOnEmptyRecall) return
    const state = stateOf(payload.agent)
    if (!state.emptyRecall || state.reflected) return
    state.reflected = true
    try {
      payload.agent.steer(createUserMessage({
        content: [{ type: 'text', text: REFLECTION }],
        source: {
          kind: 'pseudo-agi-controller',
          form: 'notice',
          summary: '检索未命中：收尾需声明没找到',
        },
      }))
    } catch (error) {
      // Steering can be refused while the turn is already closing; that is a
      // lost reflection, not a failed turn.
      ctx.logger.warn(`pseudo-agi-controller: reflection not delivered: ${String(error)}`)
    }
  })
}
