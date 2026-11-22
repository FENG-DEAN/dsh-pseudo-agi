/**
 * Configuration and load-time validation for the controlled-hands layer.
 *
 * @module @pseudo-agi/tools/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. */
export interface ToolsConfig {
  /** Workspace root every relative path is resolved against. */
  readonly workspaceRoot: string
  /** Directories (relative to the root) that readonly search may read. */
  readonly knowledgeRoots: string[]
  /** Directories (relative to the root) that guarded writes may touch. */
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
}

/** Schemastery schema; invalid config fails at load time. */
export const Config: z<ToolsConfig> = z.object({
  workspaceRoot: z.string().default('.'),
  knowledgeRoots: z.array(z.string()).default(['docs', '.pseudo-agi/memory']),
  writeRoots: z.array(z.string()).default(['.']),
  maxScanBytes: z.number().default(512 * 1024),
  maxSnippetChars: z.number().default(240),
  maxWriteBytes: z.number().default(256 * 1024),
  maxDepth: z.number().default(6),
  writeRequiresApproval: z.boolean().default(true),
  deniedSegments: z.array(z.string()).default(['.git', 'node_modules', '.ssh', '.env']),
  deniedExtensions: z.array(z.string()).default(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1']),
})

/**
 * Assert what Schemastery cannot express.
 * @param config - the resolved configuration.
 */
export function validateConfig(config: ToolsConfig): void {
  const fail = (message: string): never => {
    throw new Error(`pseudo-agi-tools: ${message}`)
  }
  if (config.workspaceRoot.trim().length === 0) fail('config.workspaceRoot must not be empty')
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
