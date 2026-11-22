/**
 * Guard and approval policy for the controlled hands.
 *
 * The two mechanisms are deliberately kept apart:
 *
 * - `ctx.tools.guard()` is a **monotonic veto**: it can only deny. It runs
 *   after every `tools/pre-execute` listener and before the body, so no later
 *   listener can turn a denial back into permission.
 * - `tools/pre-execute` returns `ask`, which delegates the decision to
 *   `ctx.approval` — an approval is a *grant* for one call, never a relaxation
 *   of the guard.
 *
 * @module @pseudo-agi/tools/policy
 */

import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { ToolsConfig } from './config.js'
import { denyReason, resolveInside } from './workspace.js'

/** The one write tool this plugin owns. */
export const WRITE_TOOL = 'controlled_write'

/** Every tool this plugin owns; the guard ignores everything else. */
export const OWNED_TOOLS: ReadonlySet<string> = new Set(['kb_search', 'kb_read', WRITE_TOOL])

/**
 * Build the synchronous write guard.
 * @param config - deployment configuration.
 * @param root - absolute workspace root.
 * @returns a guard that denies out-of-root, denied-segment, and denied-extension writes.
 */
export function createWriteGuard(config: ToolsConfig, root: string): ToolGuard {
  return (exec: Readonly<ToolExecution>): string | undefined => {
    if (exec.name !== WRITE_TOOL) return undefined
    const args = exec.arguments as { path?: unknown } | undefined
    if (args === undefined || typeof args.path !== 'string') {
      return 'controlled_write 缺少字符串 path 参数'
    }
    let absolute: string
    try {
      absolute = resolveInside(root, args.path)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return denyReason(config, root, absolute)
  }
}

/**
 * Decide whether one call must go through the approval service.
 * @param config - deployment configuration.
 * @param exec - the pending call.
 * @returns the pre-execute decision; `next` is signalled by returning undefined.
 */
export function approvalDecision(config: ToolsConfig, exec: Readonly<ToolExecution>): PreToolDecision | undefined {
  if (!config.writeRequiresApproval) return undefined
  if (exec.name !== WRITE_TOOL) return undefined
  // Approval is a turn-scoped question to a user: without an owning agent there
  // is nobody to ask, so the call fails closed instead of proceeding silently.
  if (exec.agent === undefined) {
    return { kind: 'deny', reason: '写操作需要审批，但该调用没有归属 agent，无法发起审批：已拒绝。' }
  }
  if (exec.signal.aborted) return { kind: 'cancel' }
  const args = exec.arguments as { path?: unknown } | undefined
  const path = typeof args?.path === 'string' ? args.path : '(unknown)'
  return {
    kind: 'ask',
    reason: `写入工作区文件：${path}`,
    displayReason: {
      en: `Allow writing ${path}?`,
      zh: `是否允许写入文件 ${path}？`,
    },
  }
}
