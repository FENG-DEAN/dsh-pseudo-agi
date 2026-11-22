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
import type { SandboxMode, SandboxModeOf } from './policy.js'
import { registerControlledTools } from './tools.js'
import { workspaceRoot } from './workspace.js'

export { Config }
export type { ToolsConfig }
export { WRITE_TOOL } from './policy.js'

/** Plugin name. */
export const name = 'pseudo-agi-tools'

/** The tool registry is the only hard dependency. */
export const inject = ['tools']

/** The shape of `ctx.sandboxPolicy` this plugin consumes. */
interface SandboxPolicyLike {
  resolve(request?: { session?: unknown }): { mode?: SandboxMode }
}

/** The optional-injection seam, kept structural so this package needs no dependency on the policy package. */
interface OptionalInject {
  inject(names: string[], callback: (scoped: unknown) => void): unknown
}

/**
 * Install the guard, the approval gate, and the tools.
 * @param ctx - plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: ToolsConfig): void {
  validateConfig(config)
  const root = workspaceRoot(config)

  /**
   * The shared file policy, when this deployment mounts `sandbox-policy`.
   * Resolved through a dependency-scoped context: reading a sibling plugin's
   * service from this fiber itself returns undefined, which would silently skip
   * the policy check and leave this tool as a back door around `read-only`.
   */
  let policy: SandboxPolicyLike | undefined
  ;(ctx as unknown as OptionalInject).inject(['sandboxPolicy'], (scoped) => {
    policy = (scoped as { sandboxPolicy?: SandboxPolicyLike }).sandboxPolicy
  })

  /** Effective file policy for one call; absent when no policy service is mounted. */
  const modeOf: SandboxModeOf = (exec) => {
    if (policy === undefined) return undefined
    try {
      return policy.resolve({ session: exec.agent }).mode
    } catch {
      // A host that cannot resolve a policy must not turn every write into a
      // denial; the containment fence below still applies.
      return undefined
    }
  }

  // Monotonic veto. Registered once, evaluated for every call, denies only the
  // one tool this plugin owns.
  ctx.tools.guard(createWriteGuard(config, root, modeOf))

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
