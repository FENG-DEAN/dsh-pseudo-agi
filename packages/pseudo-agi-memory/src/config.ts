/**
 * Deployment configuration for the memory layer.
 *
 * Every numeric bound is validated at load time so a bad config fails the
 * plugin start instead of producing silently degrading recall.
 *
 * @module @pseudo-agi/memory/config
 */

import z from '@deepseek-ai/schemastery'
import type { MemoryLayer } from './store.js'
import { MEMORY_LAYERS } from './store.js'

/** Plugin configuration. */
export interface MemoryConfig {
  /**
   * Base directory that `root` and `file` evidence references resolve against.
   * Defaults to the process cwd, but a deployment whose agent sessions do not
   * run in the process cwd must set this explicitly — otherwise recall works
   * while evidence checks look in the wrong tree.
   */
  readonly workspaceRoot: string
  /** Root directory of the memory tree, resolved against the workspace root. */
  readonly root: string
  /** Layers considered by an ordinary recall call. */
  readonly recallLayers: MemoryLayer[]
  /** Layers injected into the system prompt at every step. */
  readonly injectLayers: MemoryLayer[]
  /** Hard token budget for the injected memory block. */
  readonly maxInjectTokens: number
  /** Default number of hits a recall call returns. */
  readonly recallLimit: number
  /** Minimum absolute score for a hit. */
  readonly minScore: number
  /** Minimum share of query terms a record must match. */
  readonly minCoverage: number
  /** Records below this confidence are never injected. */
  readonly minConfidenceToInject: number
  /** Require a filesystem check for `file` evidence before a commit. */
  readonly verifyFileEvidence: boolean
  /** Keep a human-readable working-memory digest in `<root>/../working.md`. */
  readonly writeWorkingDigest: boolean
}

/** Schemastery schema; invalid config fails at load time. */
export const Config: z<MemoryConfig> = z.object({
  workspaceRoot: z.string().default('.'),
  root: z.string().default('.pseudo-agi/memory'),
  recallLayers: z.array(z.union(MEMORY_LAYERS)).default([...MEMORY_LAYERS]),
  injectLayers: z.array(z.union(MEMORY_LAYERS)).default(['semantic', 'procedural', 'episodic']),
  maxInjectTokens: z.number().default(900),
  recallLimit: z.number().default(6),
  minScore: z.number().default(1),
  minCoverage: z.number().default(0.34),
  minConfidenceToInject: z.number().default(0.5),
  verifyFileEvidence: z.boolean().default(true),
  writeWorkingDigest: z.boolean().default(true),
})

/**
 * Assert the bounds Schemastery cannot express (integer-ness, ranges, layer
 * membership). Throwing here fails the plugin load, which is the point.
 * @param config - the resolved configuration.
 */
export function validateConfig(config: MemoryConfig): void {
  const fail = (message: string): never => {
    throw new Error(`pseudo-agi-memory: ${message}`)
  }
  if (config.workspaceRoot.trim().length === 0) fail('config.workspaceRoot must not be empty')
  if (config.root.trim().length === 0) fail('config.root must not be empty')
  for (const [name, value] of [
    ['maxInjectTokens', config.maxInjectTokens],
    ['recallLimit', config.recallLimit],
    ['minScore', config.minScore],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) fail(`config.${name} must be a positive finite number`)
  }
  for (const [name, value] of [
    ['minCoverage', config.minCoverage],
    ['minConfidenceToInject', config.minConfidenceToInject],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) fail(`config.${name} must be between 0 and 1`)
  }
  for (const [name, layers] of [
    ['recallLayers', config.recallLayers],
    ['injectLayers', config.injectLayers],
  ] as const) {
    if (layers.length === 0) fail(`config.${name} must list at least one layer`)
    for (const layer of layers) {
      if (!MEMORY_LAYERS.includes(layer)) fail(`config.${name} contains unknown layer "${String(layer)}"`)
    }
  }
}
