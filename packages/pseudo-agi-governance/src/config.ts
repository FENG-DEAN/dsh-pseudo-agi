/**
 * Configuration for the governance layer.
 *
 * @module @pseudo-agi/governance/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. */
export interface GovernanceConfig {
  /** Directory receiving one JSONL file per session. */
  readonly root: string
  /** Maximum sessions kept in the in-memory metric book. */
  readonly maxSessions: number
  /** Maximum recent JSONL lines returned by `governance_report`. */
  readonly maxRecentLines: number
  /** Skip writing JSONL; metrics stay in memory only. */
  readonly journal: boolean
}

/** Schemastery schema; invalid config fails at load time. */
export const Config: z<GovernanceConfig> = z.object({
  root: z.string().default('.pseudo-agi/governance'),
  maxSessions: z.number().default(256),
  maxRecentLines: z.number().default(50),
  journal: z.boolean().default(true),
})

/**
 * Assert bounds Schemastery cannot express.
 * @param config - the resolved configuration.
 */
export function validateConfig(config: GovernanceConfig): void {
  const fail = (message: string): never => {
    throw new Error(`pseudo-agi-governance: ${message}`)
  }
  if (config.root.trim().length === 0) fail('config.root must not be empty')
  for (const [name, value] of [
    ['maxSessions', config.maxSessions],
    ['maxRecentLines', config.maxRecentLines],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      fail(`config.${name} must be a positive integer`)
    }
  }
}
