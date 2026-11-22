/**
 * Remove build output that a rebuild will regenerate.
 *
 * `tsc` never deletes: a source file that was removed leaves its compiled
 * twin behind, and `files` therefore ships it. That already happened once —
 * `pseudo-agi-scaffold/lib/router.js` survived the deletion of `router.ts` and
 * went out in the tarball. Cleaning before a build is the only reliable fix.
 *
 * Run with: pnpm clean
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Paths removed on every clean; all of them are reproducible from `src/`. */
const TARGETS = ['dist']

const packagesDir = join(projectRoot, 'packages')
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (entry.isDirectory()) TARGETS.push(join('packages', entry.name, 'lib'))
}

let removed = 0
for (const target of TARGETS) {
  const path = join(projectRoot, target)
  try {
    await stat(path)
  } catch {
    continue
  }
  await rm(path, { recursive: true, force: true })
  removed++
  console.log(`removed ${target}`)
}
console.log(removed === 0 ? 'nothing to clean' : `cleaned ${removed} path(s)`)
