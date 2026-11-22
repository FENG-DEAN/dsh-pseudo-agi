/**
 * Refuse to publish a bundle whose generated files are missing or stale.
 *
 * The bundle is installable straight from the repository (DSH runs no build step
 * for it), which means `client.js` and `vendor/node_modules/@pseudo-agi/*` are
 * committed artifacts. If someone edits a layer and forgets `pnpm vendor`, the
 * package would publish yesterday's code — or, with a fresh checkout, no code.
 *
 * `npm publish <tarball>` does not run lifecycle scripts; publishing the
 * directory (or `pnpm pack` + `npm publish` from it) does, which is exactly when
 * this check matters.
 *
 * Run automatically as `prepublishOnly`; also usable by hand.
 */

import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'pseudo-agi-bundle')

/** Generated files that must be committed for a Git/NPM install to work without a build. */
const GENERATED = [
  'client.js',
  'vendor/node_modules/@pseudo-agi/store/index.js',
  'vendor/node_modules/@pseudo-agi/memory/lib/index.js',
  'vendor/node_modules/@pseudo-agi/tools/lib/index.js',
  'vendor/node_modules/@pseudo-agi/scaffold/lib/index.js',
  'vendor/node_modules/@pseudo-agi/governance/lib/index.js',
  'vendor/node_modules/@pseudo-agi/panel/index.js',
  'vendor/node_modules/@pseudo-agi/panel/client.js',
]

const missing = []
for (const file of GENERATED) {
  const present = await stat(join(bundleDir, file)).then(() => true, () => false)
  if (!present) missing.push(file)
}

if (missing.length > 0) {
  console.error('refusing to publish: the bundle is not self-contained')
  console.error(`  missing generated file(s): ${missing.join(', ')}`)
  console.error('  rebuild them first:')
  console.error('    pnpm -r run build && pnpm vendor')
  process.exit(1)
}
