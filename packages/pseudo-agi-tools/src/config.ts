/**
 * Configuration and load-time validation for the controlled-hands layer.
 *
 * @module @pseudo-agi/tools/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. */
export interface ToolsConfig {
  /**
   * Workspace root every relative path is resolved against. Empty means the
   * platform default (`<home>/dsh-pseudo-agi`); never the process cwd.
   */
  readonly workspaceRoot: string
  /**
   * Default knowledge-base root, relative to the workspace root or absolute.
   * A pointer file at `<workspaceRoot>/.pseudo-agi/store.json` overrides it, so
   * one move re-points every layer instead of four config rows.
   */
  readonly storeRoot: string
  /**
   * Directories the readonly search may read, and the store-relative defaults
   * for `kb_search`. `.pseudo-agi/...` entries follow the live store root; an
   * absolute entry outside the workspace is allowed for reading.
   */
  readonly knowledgeRoots: string[]
  /**
   * Directories guarded writes may touch. `kb_store relocate` is exempt from
   * this list by design (moving the knowledge base is the point), but it still
   * obeys the session file policy and the denial rules.
   */
  readonly writeRoots: string[]
  /** Maximum size of one file the search walks. */
  readonly maxScanBytes: number
  /** Maximum size the search returns in one hit snippet. */
  readonly maxSnippetChars: number
  /** Maximum size of one written file. */
  readonly maxWriteBytes: number
  /** Recursion depth for the readonly walk. */
  readonly maxDepth: number
  /** Require an approval for every write call. */
  readonly writeRequiresApproval: boolean
  /** Path segments that are never readable or writable. */
  readonly deniedSegments: string[]
  /** File extensions that writes may never create. */
  readonly deniedExtensions: string[]
  /**
   * Let each call also reach the Session's current directory.
   *
   * A Session may be opened in a project directory that differs from the
   * configured workspace root. When on (default), the working-directory
   * service's current directory joins the allowed roots of `kb_search`,
   * `kb_read`, and `controlled_write`, so the hands follow the project without
   * any path configuration. Relative paths still resolve against
   * `workspaceRoot`, which keeps the workbench and the knowledge base one tree.
   */
  readonly followSessionRoot: boolean
}

/** Schemastery schema; invalid config fails at load time. */
export const Config: z<ToolsConfig> = z.object({
  workspaceRoot: z.string().default(''),
  storeRoot: z.string().default('.pseudo-agi'),
  knowledgeRoots: z.array(z.string()).default(['docs', '.pseudo-agi/memory']),
  writeRoots: z.array(z.string()).default(['.']),
  maxScanBytes: z.number().default(512 * 1024),
  maxSnippetChars: z.number().default(240),
  maxWriteBytes: z.number().default(256 * 1024),
  maxDepth: z.number().default(6),
  writeRequiresApproval: z.boolean().default(true),
  deniedSegments: z.array(z.string()).default(['.git', 'node_modules', '.ssh', '.env']),
  deniedExtensions: z.array(z.string()).default(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1']),
  followSessionRoot: z.boolean().default(true),
})

/**
 * Assert what Schemastery cannot express.
 * @param config - the resolved configuration.
 */
export function validateConfig(config: ToolsConfig): void {
  const fail = (message: string): never => {
    throw new Error(`pseudo-agi-tools: ${message}`)
  }
  if (config.storeRoot.trim().length === 0) fail('config.storeRoot must not be empty')
  if (config.knowledgeRoots.length === 0) fail('config.knowledgeRoots must list at least one directory')
  if (config.writeRoots.length === 0) fail('config.writeRoots must list at least one directory')
  for (const [name, value] of [
    ['maxScanBytes', config.maxScanBytes],
    ['maxSnippetChars', config.maxSnippetChars],
    ['maxWriteBytes', config.maxWriteBytes],
    ['maxDepth', config.maxDepth],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) fail(`config.${name} must be a positive finite number`)
  }
  for (const segment of config.deniedSegments) {
    if (segment.includes('/') || segment.includes('\\')) {
      fail(`config.deniedSegments entries must be single path segments (got "${segment}")`)
    }
  }
  for (const extension of config.deniedExtensions) {
    if (!extension.startsWith('.')) fail(`config.deniedExtensions entries must start with "." (got "${extension}")`)
  }
}
