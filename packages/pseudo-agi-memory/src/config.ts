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
   * Empty means the platform default (`<home>/dsh-pseudo-agi`). Never the process
   * cwd: the host runs from its install directory, which differs per machine and
   * may not be writable.
   */
  readonly workspaceRoot: string
  /**
   * Default knowledge-base root, relative to the workspace root or absolute.
   * Only a default: when `<workspaceRoot>/.pseudo-agi/store.json` exists it
   * names the live root and wins, so a relocation takes effect in every layer
   * at once instead of in four configs that can drift apart.
   */
  readonly storeRoot: string
  /**
   * Root directory of the memory tree. A path starting with `.pseudo-agi` is
   * resolved against the live store root (see {@link storeRoot}); anything else
   * keeps its old meaning and resolves against `workspaceRoot`.
   */
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
  /**
   * Create a starter `AGI_STATE.md` at the workspace root on first load.
   *
   * The startup protocol reads that file before recall, so a fresh install with
   * no file would make its first step read nothing and the panel would show an
   * empty workbench forever. The skeleton is written only when the file is
   * absent, never overwritten, and skipped under a `read-only` session policy.
   */
  readonly createBench: boolean
}

/** Schemastery schema; invalid config fails at load time. */
export const Config: z<MemoryConfig> = z.object({
  workspaceRoot: z.string().default(''),
  storeRoot: z.string().default('.pseudo-agi'),
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
  createBench: z.boolean().default(true),
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
  if (config.storeRoot.trim().length === 0) fail('config.storeRoot must not be empty')
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
