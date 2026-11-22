/**
 * Consciousness-scaffold entry point for the bundled artifact.
 *
 * The patch names this specifier instead of `@pseudo-agi/scaffold` so the
 * loader can resolve it from the profile while the implementation stays in the
 * bundle's own `node_modules`. See ./README.md.
 */
export * from '@pseudo-agi/scaffold'
