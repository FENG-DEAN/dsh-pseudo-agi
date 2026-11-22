/**
 * Governance layer entry point.
 *
 * Re-exports the **vendored** copy by relative path. A profile that fetched this
 * package has no install step for its siblings, so nothing here may resolve a
 * package name that lives outside the bundle. See ../vendor/README.md.
 */
export * from '../vendor/node_modules/@pseudo-agi/governance/lib/index.js'
