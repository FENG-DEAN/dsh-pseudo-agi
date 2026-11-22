/**
 * Governance layer entry point for the bundled artifact.
 *
 * The patch names this specifier instead of `@pseudo-agi/governance` so the
 * loader can resolve it from the profile while the implementation stays in the
 * bundle's own `node_modules`. See ./README.md.
 */
export * from '@pseudo-agi/governance'
