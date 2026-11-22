/**
 * Vendor the six layer packages into the bundle, and generate its browser half.
 *
 * Why this exists — the DSH rule for a shippable bundle is "open the box and it
 * runs":
 *
 *   - a bundle installed straight from a Git repository gets **no install step**
 *     for its siblings, and `workspace:` dependencies cannot be resolved outside
 *     the workspace at all;
 *   - the `client.js` artifact is loaded as-is; the host never builds it.
 *
 * So the compiled layers and the browser bundle are committed here as generated
 * files, under `vendor/node_modules/@pseudo-agi/*` — a real `node_modules` layout,
 * so each vendored package still resolves its sibling `@pseudo-agi/store` through
 * the ordinary Node lookup, with no install step needed.
 *
 * The patch rows name `@pseudo-agi/bundle/layers/<layer>`; those files re-export
 * from the vendored copy by relative path. Nothing in the installed artifact
 * depends on a package name outside the bundle.
 *
 * Run with: pnpm vendor   (after `pnpm -r run build`)
 */

import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(projectRoot, 'packages')
const bundleDir = join(packagesDir, 'pseudo-agi-bundle')
const vendorDir = join(bundleDir, 'vendor', 'node_modules', '@pseudo-agi')

/** What each layer contributes to the vendored copy. `.map` files are skipped. */
const LAYERS = {
  store: ['index.js', 'index.d.ts'],
  memory: ['lib'],
  tools: ['lib'],
  scaffold: ['lib'],
  governance: ['lib'],
  panel: ['index.js', 'client.js'],
}

/** Shared files a vendored package keeps so it reads like a real package. */
const META = ['package.json', 'README.md', 'LICENSE']

/** Copy a tree, skipping source maps: they point outside the artifact. */
async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, target)
    else if (!entry.name.endsWith('.map')) await copyFile(source, target)
  }
}

await rm(vendorDir, { recursive: true, force: true })
let files = 0
let bytes = 0

for (const [name, entries] of Object.entries(LAYERS)) {
  const source = join(packagesDir, `pseudo-agi-${name}`)
  const target = join(vendorDir, name)
  await mkdir(target, { recursive: true })
  for (const item of [...META, ...entries]) {
    const from = join(source, item)
    const info = await stat(from).catch(() => undefined)
    if (info === undefined) throw new Error(`${name}: missing ${item} — run pnpm -r run build first`)
    if (info.isDirectory()) await copyTree(from, join(target, item))
    else await copyFile(from, join(target, item))
  }
  // Count what actually landed, so the report cannot drift from the tree.
  async function count(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await count(path)
      else {
        files++
        bytes += (await stat(path)).size
      }
    }
  }
  await count(target)
  console.log(`  vendored @pseudo-agi/${name}`)
}

// The browser half: the client module system identifies a package by its Loader
// entry name, which is this package, so the factory id must say so.
const panelClient = await readFile(join(packagesDir, 'pseudo-agi-panel', 'client.js'), 'utf8')
const factoryId = /id:\s*'@pseudo-agi\/panel'/
assert.match(panelClient, factoryId, 'panel/client.js no longer declares id: \'@pseudo-agi/panel\'')
const bundleClient = panelClient.replace(factoryId, "id: '@pseudo-agi/bundle'")
assert.notEqual(bundleClient, panelClient, 'the bundle client must differ from the panel client by its factory id')
await writeFile(join(bundleDir, 'client.js'), bundleClient, 'utf8')
files++
bytes += Buffer.byteLength(bundleClient, 'utf8')
console.log('  generated client.js from pseudo-agi-panel/client.js')

console.log(`\nvendored ${Object.keys(LAYERS).length} packages + client.js → ${relative(projectRoot, vendorDir)}`)
console.log(`  ${files} files, ${(bytes / 1024).toFixed(0)} KiB (commit these: the artifact must not need a build step)`)
