/**
 * Layered memory plugin.
 *
 * Four responsibilities, each on a contract the harness already owns:
 *
 * 1. **Storage** — Markdown files under `<root>/<layer>/`; the files are the
 *    source of truth and nothing is lost if the process dies.
 * 2. **Recall** — a tool (`memory_recall`) that always returns sources, and an
 *    explicit miss result instead of a plausible guess.
 * 3. **Injection** — a `systemPrompt.context` entry recomputed at
 *    `agent/pre-step`, so every step sees the same bounded, budgeted block.
 * 4. **Write gating** — candidate → evidence check → commit.
 *
 * Everything registered here is owned by the plugin fiber and unwinds on
 * unload (including the pre-step listener, the prompt context, and the tools).
 *
 * @module @pseudo-agi/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
// Type-only imports keep the required service declarations in this module's
// face without a runtime edge to plugins that may be unloaded.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

import { Config, validateConfig } from './config.js'
import type { MemoryConfig } from './config.js'
import { fitWithinBudget } from './budget.js'
import type { PseudoAgiMemoryRecallEvent } from './events.js'
import type { Evidence } from './store.js'
import { MemoryStore } from './store.js'
import { registerMemoryTools, toBudgetEntry } from './tools.js'
import { refreshWorkingDigest } from './digest.js'

export { Config }
export type { MemoryConfig }
export type { PseudoAgiMemoryRecallEvent }
export type { MemoryLayer, MemoryRecord, Evidence } from './store.js'
export { MEMORY_LAYERS } from './store.js'

/** Plugin name; the loader also accepts the package name. */
export const name = 'pseudo-agi-memory'

/**
 * The tool registry is the one hard dependency: without it this plugin has no
 * model-facing surface. `systemPrompt` is joined optionally below, so the
 * plugin still loads on a deployment that registers no prompt registry.
 */
export const inject = ['tools']

/**
 * Runtime context order. Deliberately a plain number, not
 * `getContextOrder()`: that enum is the harness's own placement, and a
 * third-party contribution should not claim one of its slots. 400 sits after
 * working-directory (100) and harness source (200), before tool guidance.
 */
const MEMORY_CONTEXT_ORDER = 400

/**
 * Register storage, recall tools, the per-step injection, and the digest.
 * @param ctx - plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: MemoryConfig): void {
  validateConfig(config)
  // Every relative path in this plugin — the memory tree and `file` evidence
  // refs — resolves against the configured workspace root, never against the
  // process cwd, because an agent session's cwd can differ from the host's.
  const workspaceRoot = resolve(config.workspaceRoot)
  const store = new MemoryStore(resolve(workspaceRoot, config.root))
  // Keyed by the live Agent object, so disposal of an agent drops its block.
  const injected = new WeakMap<object, string>()

  const report = (message: string): void => {
    ctx.logger.warn(`pseudo-agi-memory: ${message}`)
  }

  /**
   * Recompute this step's injected block. Runs inside `agent/pre-step`, which
   * settles before the step's prompt assembly, so the block is never stale by
   * one step.
   * @param agent - the agent whose step is being prepared.
   */
  const refreshInjection = async (agent: object): Promise<void> => {
    try {
      const scanned = await store.scan(config.injectLayers)
      for (const error of scanned.errors) report(`skipping unreadable record: ${error}`)
      const entries = scanned.records
        .filter(record => record.confidence >= config.minConfidenceToInject)
        .map(toBudgetEntry)
      const fitted = fitWithinBudget(entries, config.maxInjectTokens)
      if (fitted.included === 0) {
        injected.delete(agent)
        return
      }
      injected.set(agent, fitted.text)
    } catch (error) {
      // Injection is an enhancement: a broken memory tree must not fail the step.
      report(`injection refresh failed: ${String(error)}`)
    }
  }

  // The digest is a projection of the tree, refreshed only when the tree
  // actually changed. Two triggers on purpose: the first step of every turn
  // (a long turn must not leave a stale projection) and every mutating tool.
  // `agent/turn-stopping` is kept as a third, cheap no-op when current.
  let digestKey: string | undefined
  const refreshDigest = async (): Promise<void> => {
    if (!config.writeWorkingDigest) return
    try {
      const next = await refreshWorkingDigest(store, digestKey)
      if (next !== undefined) digestKey = next
    } catch (error) {
      report(`working digest refresh failed: ${String(error)}`)
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    await refreshInjection(payload.agent)
    if (payload.step === 1) await refreshDigest()
    return next()
  })

  ctx.on('agent/turn-stopping', async () => {
    await refreshDigest()
  })

  // Optional join: the prompt registry may be absent in a minimal deployment.
  ctx.inject(['systemPrompt'], (scope: Context) => {
    scope.systemPrompt.context({
      name: 'pseudo-agi:memory',
      order: MEMORY_CONTEXT_ORDER,
      // Memory bodies are arbitrary text: `{{...}}` must stay literal.
      interpolate: false,
      text: (assembly) => {
        const agent = assembly.agent
        if (agent === undefined) return ''
        const block = injected.get(agent)
        if (block === undefined) return ''
        return '当前长期记忆（每步刷新；这是过去结论，不是本步证据。'
          + '回答前必须核对其来源；证据不足就声明没找到，不得用训练知识补全）：\n'
          + block
      },
    })
  })

  const emitRecall = (event: PseudoAgiMemoryRecallEvent): void => {
    ctx.emit('pseudo-agi/memory-recall', event)
  }

  const verifyEvidence = async (evidence: readonly Evidence[]): Promise<string[]> => {
    if (evidence.length === 0) return ['(无证据)']
    if (!config.verifyFileEvidence) return []
    const missing: string[] = []
    for (const item of evidence) {
      if (item.kind !== 'file') continue
      const path = isAbsolute(item.ref) ? item.ref : resolve(workspaceRoot, item.ref)
      try {
        await access(path)
      } catch {
        missing.push(item.ref)
      }
    }
    return missing
  }

  registerMemoryTools(ctx, {
    store,
    config,
    verifyEvidence,
    emitRecall,
    refreshDigest,
    sessionOf: exec => (exec.agent === undefined ? 'unknown' : String(exec.agent.id)),
  })
}
