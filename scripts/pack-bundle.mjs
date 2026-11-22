/**
 * Produce one distributable tarball of the **self-contained** bundle.
 *
 * The bundle directory is already installable as-is: it carries its six layers
 * under `vendor/node_modules/@pseudo-agi/*` and its browser half as `client.js`,
 * both committed. So this step is deliberately thin — `pnpm pack` the directory,
 * read the archive back, and refuse to hand out anything that is not self-contained.
 *
 * The tarball exists for distribution without a registry: attach it to a GitHub
 * Release (or any static URL) and install that URL directly.
 *
 * Run with: pnpm pack-bundle [--out <dir>]
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmCommand } from './lib/pnpm-command.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = projectRoot

/** Layers the artifact must carry, with the entry file each one exposes. */
const CARRIED = {
  store: 'index.js',
  memory: 'lib/index.js',
  tools: 'lib/index.js',
  scaffold: 'lib/index.js',
  governance: 'lib/index.js',
  panel: 'index.js',
}

/** Patch rows; each layer entry file must exist in the artifact. */
const LAYER_ENTRIES = ['memory', 'tools', 'scaffold', 'governance', 'panel']

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function tarballEntries(tarball) {
  return run('tar', ['-tzf', tarball]).split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.endsWith('/'))
    .map(line => line.replace(/^package\//, ''))
    .sort()
}

function argValue(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

const outDir = resolve(projectRoot, argValue('--out') ?? 'dist')
const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
const version = String(manifest.version)
const tag = `pseudo-agi-bundle-${version}`

if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  console.error('pack-bundle: the bundle must not declare dependencies (it is self-contained)')
  process.exit(1)
}

await mkdir(outDir, { recursive: true })
const staging = join(tmpdir(), `.pack-bundle-${process.pid}`)
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })

try {
  const { command, args } = pnpmCommand()
  run(command, [...args, '-C', bundleDir, 'pack', '--pack-destination', staging], { cwd: projectRoot })
  const packed = (await readdir(staging)).find(file => file.startsWith('pseudo-agi-bundle-') && file.endsWith('.tgz'))
  assert.ok(packed, 'pnpm pack produced no tarball')

  const tarball = join(outDir, `${tag}.tgz`)
  await rm(tarball, { force: true })
  await copyFile(join(staging, packed), tarball)

  // Read the artifact back: only the archive knows what packaging actually kept.
  const entries = tarballEntries(tarball)
  const required = [
    'package.json', 'README.md', 'LICENSE', 'index.js', 'cordis.patch.yml', 'client.js',
    ...LAYER_ENTRIES.map(layer => `layers/${layer}.js`),
    ...Object.entries(CARRIED).map(([name, entry]) => `vendor/node_modules/@pseudo-agi/${name}/${entry}`),
  ]
  for (const entry of required) {
    assert.ok(entries.includes(entry), `artifact is missing ${entry} — run pnpm -r run build && pnpm vendor`)
  }
  for (const entry of entries) {
    assert.doesNotMatch(entry, /node_modules\/@deepseek-ai\//, `host package leaked into the artifact: ${entry}`)
    assert.doesNotMatch(entry, /\.map$/, `source map in the artifact: ${entry}`)
  }

  const bytes = (await stat(tarball)).size
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  await writeFile(join(outDir, `${tag}.manifest.json`), `${JSON.stringify({
    file: `${tag}.tgz`,
    version,
    bytes,
    sha256,
    files: entries.length,
    packages: Object.fromEntries(Object.keys(CARRIED).map(name => [name, version])),
    layers: LAYER_ENTRIES,
  }, null, 2)}\n`, 'utf8')

  console.log(`\npacked ${relative(projectRoot, tarball) || tarball}`)
  console.log(`  ${bytes} bytes, ${entries.length} files, sha256 ${sha256.slice(0, 16)}…`)
  console.log(`  self-contained: ${Object.keys(CARRIED).length} layers under vendor/, client.js, no host packages`)
  console.log(`  install: pnpm add ${tarball}`)
  console.log('  online: attach it to a GitHub Release (or any static URL) and install that URL')
} finally {
  await rm(staging, { recursive: true, force: true })
}
