/**
 * Controlled hands plugin.
 *
 * Two seams, in this order, for every write:
 *
 * 1. `tools/pre-execute` returns `ask` — the approval service decides whether
 *    this one call may proceed, and the decision is audited on the session log.
 * 2. `ctx.tools.guard()` — a monotonic veto that runs after every pre-execute
 *    listener and before the body. It cannot be reversed by an approval.
 *
 * Readonly tools get no gate: they can only read, and every result carries its
 * source. The tool registrations, the guard, and the listener are all owned by
 * the plugin fiber and vanish together on unload.
 *
 * @module @pseudo-agi/tools
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings the `ctx.tools` and tool-event declarations into scope.
import type {} from '@deepseek-ai/dsh-tools'

import { Config, validateConfig } from './config.js'
import type { ToolsConfig } from './config.js'
import { OWNED_TOOLS, approvalDecision, createWriteGuard } from './policy.js'
import { registerControlledTools } from './tools.js'
import { workspaceRoot } from './workspace.js'

export { Config }
export type { ToolsConfig }
export { WRITE_TOOL } from './policy.js'

/** Plugin name. */
export const name = 'pseudo-agi-tools'

/** The tool registry is the only hard dependency. */
export const inject = ['tools']

/**
 * Install the guard, the approval gate, and the tools.
 * @param ctx - plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: ToolsConfig): void {
  validateConfig(config)
  const root = workspaceRoot(config)

  // Monotonic veto. Registered once, evaluated for every call, denies only the
  // one tool this plugin owns.
  ctx.tools.guard(createWriteGuard(config, root))

  // Approval gate. `ask` is a grant request for one call; it never weakens the
  // guard above. Anything not owned by this plugin is delegated untouched.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!OWNED_TOOLS.has(exec.name)) return next()
    const decision = approvalDecision(config, exec)
    if (decision === undefined) return next()
    return decision
  })

  registerControlledTools(ctx, { config, root })
}
