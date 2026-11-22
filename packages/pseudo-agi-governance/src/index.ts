/**
 * Governance and evaluation plugin.
 *
 * Strictly an observer: it subscribes to events the harness already emits and
 * never influences a decision. Two consequences follow, and both are intended:
 *
 * - It cannot become a failure mode of the agent. Every listener is wrapped,
 *   and the journal swallows its own errors after the first report.
 * - It sees exactly what the other layers did (routes, recalls, tool outcomes),
 *   because those layers report on the event bus rather than by direct calls.
 *
 * The JSONL journal is flushed on unload through `ctx.effect`, so a plugin
 * reload cannot leave a half-written queue behind.
 *
 * @module @pseudo-agi/governance
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: event vocabulary published by the other layers.
import type {} from '@pseudo-agi/controller/events'
import type {} from '@pseudo-agi/memory/events'

import { Config, validateConfig } from './config.js'
import type { GovernanceConfig } from './config.js'
import { JsonlJournal, MetricsBook } from './metrics.js'
import { registerGovernanceTools } from './tools.js'

export { Config }
export type { GovernanceConfig }
export type { JournalRecord, SessionMetrics } from './metrics.js'

/** Plugin name. */
export const name = 'pseudo-agi-governance'

/** Needs the tool registry to publish `governance_report`. */
export const inject = ['tools']

/**
 * Install the observers and the report tool.
 * @param ctx - plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: GovernanceConfig): void {
  validateConfig(config)
  const book = new MetricsBook(config.maxSessions)
  const journal = new JsonlJournal(resolve(process.cwd(), config.root), message => {
    ctx.logger.warn(`pseudo-agi-governance: ${message}`)
  })

  // Resource owned by this plugin but not by Cordis itself: the pending write
  // queue. Registering the drain as an effect makes unload deterministic.
  ctx.effect(() => async () => {
    await journal.flush()
  })

  const record = (
    sessionId: string,
    kind: string,
    detail: Record<string, unknown>,
  ): void => {
    if (!config.journal) return
    journal.write({ at: new Date().toISOString(), sessionId, kind, detail })
  }

  const touch = (sessionId: string) => {
    const metrics = book.of(sessionId)
    metrics.lastAt = new Date().toISOString()
    return metrics
  }

  // `agent/pre-step` is a waterfall: an observer that forgets `next()` would
  // veto every step. Recording first and delegating immediately is the contract.
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = String(payload.agent.id)
    const metrics = touch(sessionId)
    metrics.steps++
    record(sessionId, 'step', { turn: payload.turn, step: payload.step, messages: payload.messages.length })
    return next()
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const sessionId = String(payload.agent.id)
    const metrics = touch(sessionId)
    metrics.turns++
    record(sessionId, 'turn', { turn: payload.turn })
  })

  ctx.on('agent/error', (payload) => {
    const sessionId = String(payload.agent.id)
    const metrics = touch(sessionId)
    metrics.errors++
    record(sessionId, 'error', {
      turn: payload.turn,
      step: payload.step,
      message: payload.error instanceof Error ? payload.error.message : String(payload.error),
    })
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const sessionId = String(agent.id)
    const metrics = touch(sessionId)
    metrics.toolCalls++
    if (result.isError) metrics.toolFailures++
    // Arguments are deliberately not journaled: they are the most likely place
    // for secrets and user content to leak into an audit file.
    record(sessionId, 'tool', {
      name: exec.name,
      callId: String(exec.callId),
      isError: result.isError,
    })
    return undefined
  })

  ctx.on('pseudo-agi/memory-recall', (payload) => {
    const metrics = touch(payload.sessionId)
    metrics.memoryRecalls++
    if (payload.found) metrics.memoryHits++
    record(payload.sessionId, 'memory', {
      found: payload.found,
      hitCount: payload.hitCount,
      considered: payload.considered,
      topScore: Number(payload.topScore.toFixed(3)),
      query: payload.query.slice(0, 200),
    })
  })

  ctx.on('pseudo-agi/controller-decision', (payload) => {
    const metrics = touch(payload.sessionId)
    metrics.controllerDecisions++
    if (payload.injected) metrics.controllerInjections++
    metrics.routes[payload.route] = (metrics.routes[payload.route] ?? 0) + 1
    record(payload.sessionId, 'route', {
      route: payload.route,
      reason: payload.reason,
      injected: payload.injected,
      turn: payload.turn,
      step: payload.step,
    })
  })

  registerGovernanceTools(ctx, { book, journal, config })
}
