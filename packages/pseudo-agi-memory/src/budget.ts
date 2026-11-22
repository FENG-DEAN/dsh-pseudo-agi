/**
 * Prompt-budget math for injected memory.
 *
 * Injection repeats on every step, so the budget is enforced before the text
 * ever reaches the prompt registry: a mis-sized memory tree must degrade by
 * dropping whole records, never by truncating one mid-sentence.
 *
 * @module @pseudo-agi/memory/budget
 */

import type { MemoryLayer } from './store.js'

/** One candidate block for the injected memory region. */
export interface BudgetEntry {
  readonly id: string
  readonly title: string
  readonly layer: MemoryLayer
  readonly updatedAt: string
  readonly confidence: number
  readonly text: string
}

/** Result of fitting entries into the budget. */
export interface BudgetResult {
  readonly text: string
  readonly included: number
  readonly dropped: number
  readonly tokens: number
}

/**
 * Conservative token estimate that respects CJK.
 *
 * A character-count heuristic of `chars / 4` is right for latin prose but
 * undercounts CJK by roughly 4×, which would let a Chinese memory tree blow
 * through a budget expressed in tokens. CJK block characters are counted as
 * one token each; everything else as one token per four characters, rounded up.
 * @param text - text to measure.
 * @returns an estimated token count.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * Render the largest prefix of `entries` (newest first) that fits the budget.
 * @param entries - candidate blocks; callers order is irrelevant.
 * @param maxTokens - hard token budget.
 * @returns the joined text plus inclusion statistics.
 */
export function fitWithinBudget(entries: readonly BudgetEntry[], maxTokens: number): BudgetResult {
  const ordered = [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const blocks: string[] = []
  let tokens = 0
  let included = 0
  for (const entry of ordered) {
    const block = `- [${entry.layer}] ${entry.title}（置信度 ${entry.confidence.toFixed(2)}，更新于 ${entry.updatedAt.slice(0, 10)}）\n  ${entry.text}`
    const cost = estimateTokens(block)
    if (tokens + cost > maxTokens) break
    blocks.push(block)
    tokens += cost
    included++
  }
  return {
    text: blocks.join('\n'),
    included,
    dropped: ordered.length - included,
    tokens,
  }
}
