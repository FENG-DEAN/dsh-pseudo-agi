/**
 * Refuse to publish the bundle's source directory.
 *
 * The publishable artifact is built by `scripts/pack-bundle.mjs`: it assembles the
 * six implementation packages as plain directories. Publishing straight from
 * `packages/pseudo-agi-bundle` instead runs `pnpm pack` over the workspace
 * symlinks, which expands the bundled dependencies into their whole installed
 * tree — observed: `node_modules/@deepseek-ai/cosmokit/LICENSE` inside the
 * tarball. Host packages must never be redistributed this way; the host owns
 * them as peers.
 *
 * `npm publish <tarball>` does not run lifecycle scripts, so the generated
 * artifact (which contains `client.js`) publishes fine. Only the source
 * directory is stopped.
 *
 * Run automatically as `prepublishOnly`; also usable by hand.
 */

import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'pseudo-agi-bundle')

/** Files that only exist in the generated artifact, never in the source tree. */
const GENERATED = ['client.js']

const missing = []
for (const file of GENERATED) {
  const present = await stat(join(bundleDir, file)).then(() => true, () => false)
  if (!present) missing.push(file)
}

if (missing.length > 0) {
  console.error('refusing to publish the bundle source directory')
  console.error(`  missing generated file(s): ${missing.join(', ')}`)
  console.error('  build the artifact first and publish that instead:')
  console.error('    pnpm pack-bundle')
  console.error('    npm publish dist/pseudo-agi-bundle-<version>.tgz --access public')
  process.exit(1)
}
