/**
 * Path containment and denial rules shared by the guard, the approval gate,
 * and the tools themselves.
 *
 * The guard is synchronous by contract, so these checks are pure string/path
 * math. Anything requiring the filesystem (symlink resolution, existence) is
 * re-checked inside the tool body, where awaiting is allowed.
 *
 * @module @pseudo-agi/tools/workspace
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolsConfig } from './config.js'

/** Whether two paths are compared case-insensitively on this platform. */
const CASELESS = process.platform === 'win32' || process.platform === 'darwin'

/** Normalize a path for containment comparison. */
function comparable(path: string): string {
  const normalized = resolve(path)
  return CASELESS ? normalized.toLowerCase() : normalized
}

/**
 * Case-fold a bare token: one path segment or one file extension. Never
 * resolves it — `resolve('.ps1')` would fabricate a path under the cwd and
 * silently defeat the match.
 * @param token - a segment name or an extension.
 * @returns the token, lower-cased on case-insensitive platforms.
 */
function fold(token: string): string {
  return CASELESS ? token.toLowerCase() : token
}

/**
 * Whether `target` is inside `root` (or is `root` itself).
 * @param root - containing directory.
 * @param target - candidate path.
 * @returns true when contained.
 */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(comparable(root), comparable(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Absolute workspace root for one deployment. */
export function workspaceRoot(config: ToolsConfig): string {
  return resolve(config.workspaceRoot)
}

/**
 * Resolve a model-supplied path against the workspace root. Absolute input is
 * accepted only if it is already inside the root.
 * @param root - workspace root.
 * @param candidate - model-supplied path.
 * @returns the absolute path.
 * @throws when the path escapes the root.
 */
export function resolveInside(root: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  if (!isWithin(root, absolute)) {
    throw new Error(`路径越界：${JSON.stringify(candidate)} 不在工作区 ${root} 内`)
  }
  return absolute
}

/**
 * Find the first denial rule a path violates, if any.
 * @param config - deployment config (denied segments/extensions).
 * @param root - workspace root.
 * @param absolute - resolved absolute path.
 * @returns a denial reason, or undefined when the path is acceptable.
 */
export function denyReason(config: ToolsConfig, root: string, absolute: string): string | undefined {
  if (!isWithin(root, absolute)) return `路径越界：必须位于工作区 ${root} 内`
  const segments = comparable(absolute).slice(comparable(root).length).split(sep).filter(Boolean)
  for (const segment of segments) {
    for (const denied of config.deniedSegments) {
      if (fold(segment) === fold(denied)) return `路径包含被禁止的片段 "${denied}"`
    }
  }
  for (const extension of config.deniedExtensions) {
    if (fold(absolute).endsWith(fold(extension))) {
      return `禁止写入扩展名 "${extension}"`
    }
  }
  return undefined
}

/**
 * Whether a path lies under one of the configured write roots.
 * @param config - deployment config.
 * @param root - workspace root.
 * @param absolute - resolved absolute path.
 * @returns true when a write root contains the path.
 */
export function isWritable(config: ToolsConfig, root: string, absolute: string): boolean {
  return config.writeRoots.some(writeRoot => isWithin(resolve(root, writeRoot), absolute))
}

/**
 * Whether a path lies under one of the configured knowledge roots.
 * @param config - deployment config.
 * @param root - workspace root.
 * @param absolute - resolved absolute path.
 * @returns true when a knowledge root contains the path.
 */
export function isReadableKnowledge(config: ToolsConfig, root: string, absolute: string): boolean {
  return config.knowledgeRoots.some(knowledgeRoot => isWithin(resolve(root, knowledgeRoot), absolute))
}
