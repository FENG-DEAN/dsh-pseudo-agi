/**
 * Build one self-contained `@pseudo-agi/bundle` tarball that installs the whole
 * pseudo-AGI from a single spec — a local file, a tarball URL, or a package name
 * once published.
 *
 * Why a bespoke packaging step instead of a plain `pnpm pack`: the artifact has to
 * carry its six sibling packages inside its own `node_modules`. A profile accepts
 * ONE spec through the plugin manager, and `@pseudo-agi/*` is not on any registry,
 * so a bundle that merely *depends* on them installs and then fails with
 * `ERR_PNPM_FETCH_404`. Verified: pnpm keeps `node_modules` that a tarball ships
 * (that is what `bundledDependencies` means), and a re-export entry point
 * (`layers/*.js`) bridges the profile-side specifier to the nested copy.
 *
 * Run with: node scripts/pack-bundle.mjs [--no-build] [--out <dir>]
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(projectRoot, 'packages', 'pseudo-agi-bundle')

/** Packages the artifact carries inside its own node_modules. */
const LAYERS = ['store', 'memory', 'tools', 'scaffold', 'governance', 'panel']

/** Files that must exist inside each carried package for it to be loadable. */
const REQUIRED_FILES = {
  store: ['index.js', 'index.d.ts'],
  memory: ['lib/index.js'],
  tools: ['lib/index.js'],
  scaffold: ['lib/index.js'],
  governance: ['lib/index.js'],
  panel: ['index.js', 'client.js'],
}

/** Entry points the patch names; each must exist and re-export its package. */
const LAYER_ENTRIES = ['memory', 'tools', 'scaffold', 'governance', 'panel']

function argValue(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

/** Run one command, inheriting nothing but stdout on failure. */
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

/** The pnpm entry point: `npm_execpath` when started by pnpm, else the bare command. */
function pnpmCommand() {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.length > 0 && execpath.endsWith('.mjs')) {
    return { command: process.execPath, args: [execpath] }
  }
  if (typeof execpath === 'string' && execpath.length > 0 && execpath.endsWith('.cjs')) {
    return { command: process.execPath, args: [execpath] }
  }
  return { command: 'pnpm', args: [] }
}

/** Whether the platform has a `tar` that accepts `-czf`. */
function tarAvailable() {
  try {
    run('tar', ['--version'])
    return true
  } catch {
    return false
  }
}

/** Walk a directory and report file count plus total bytes. */
async function measure(directory) {
  let files = 0
  let bytes = 0
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        files++
        bytes += (await stat(path)).size
      }
    }
  }
  await walk(directory)
  return { files, bytes }
}

/** Assert one carried package is complete, and return its declared version. */
async function assertPackageComplete(target, name) {
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.name, `@pseudo-agi/${name}`, `${name}: package.json name mismatch`)
  for (const file of REQUIRED_FILES[name] ?? []) {
    await stat(join(target, file)).catch(() => {
      throw new Error(`${name}: missing ${file} in the packaged copy`)
    })
  }
  return manifest.version
}

const outDir = resolve(projectRoot, argValue('--out') ?? 'dist')
const build = !process.argv.includes('--no-build')

if (!tarAvailable()) {
  console.error('pack-bundle: no usable `tar` on PATH; this step creates the tarball with it.')
  process.exit(1)
}

const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
const version = String(manifest.version)
const tag = `pseudo-agi-bundle-${version}`

if (build) {
  const { command, args } = pnpmCommand()
  console.log('building the six layer packages…')
  run(command, [...args, '-r', 'run', 'build'], { cwd: projectRoot, stdio: 'inherit' })
}

const staging = await mkdtemp(join(tmpdir(), 'pseudo-agi-pack-'))
const tarballDir = join(staging, 'tarballs')
const unpackDir = join(staging, 'unpack')
const packageRoot = join(staging, 'package')
await mkdir(tarballDir, { recursive: true })
await mkdir(unpackDir, { recursive: true })
await mkdir(packageRoot, { recursive: true })

const built = { files: 0, bytes: 0, packages: {}, warned: [] }
try {
  // 1. Pack the six layer packages with their own `files` allow-lists, so the
  //    artifact carries exactly what they publish, not the build directories.
  for (const name of LAYERS) {
    const { command, args } = pnpmCommand()
    run(command, [...args, '-C', join(projectRoot, 'packages', `pseudo-agi-${name}`),
      'pack', '--pack-destination', tarballDir], { cwd: projectRoot })
    const tarball = (await readdir(tarballDir)).find(file => file.startsWith(`pseudo-agi-${name}-`))
    assert.ok(tarball, `pack produced no tarball for ${name}`)
    const target = join(unpackDir, name)
    await mkdir(target, { recursive: true })
    run('tar', ['-xzf', join(tarballDir, tarball), '-C', target])
    const carried = join(packageRoot, 'node_modules', '@pseudo-agi', name)
    await mkdir(carried, { recursive: true })
    await cp(join(target, 'package'), carried, { recursive: true })
    const declared = await assertPackageComplete(carried, name)
    assert.equal(declared, version, `@pseudo-agi/${name}@${declared} does not match the bundle version ${version}`)
    built.packages[name] = declared
  }

  // 2. Copy the bundle's own files. The browser half is generated from the panel
  //    package: the client module system identifies a package by its Loader entry
  //    name, which is this package, so the factory id has to say `@pseudo-agi/bundle`.
  await copyFile(join(bundleDir, 'index.js'), join(packageRoot, 'index.js'))
  await copyFile(join(bundleDir, 'cordis.patch.yml'), join(packageRoot, 'cordis.patch.yml'))
  await copyFile(join(bundleDir, 'README.md'), join(packageRoot, 'README.md')).catch(() => {})
  // LICENSE is not in `files`, but a published artifact must carry it.
  await copyFile(join(bundleDir, 'LICENSE'), join(packageRoot, 'LICENSE'))
  await cp(join(bundleDir, 'locale'), join(packageRoot, 'locale'), { recursive: true })
  await mkdir(join(packageRoot, 'layers'), { recursive: true })
  for (const entry of LAYER_ENTRIES) {
    await copyFile(join(bundleDir, 'layers', `${entry}.js`), join(packageRoot, 'layers', `${entry}.js`))
  }

  const panelClient = await readFile(join(projectRoot, 'packages', 'pseudo-agi-panel', 'client.js'), 'utf8')
  const factoryId = /id:\s*'@pseudo-agi\/panel'/
  assert.match(panelClient, factoryId, 'panel/client.js no longer declares id: \'@pseudo-agi/panel\'')
  const bundleClient = panelClient.replace(factoryId, "id: '@pseudo-agi/bundle'")
  assert.notEqual(bundleClient, panelClient, 'bundle client must differ from the panel client by its factory id')
  await writeFile(join(packageRoot, 'client.js'), bundleClient, 'utf8')

  // 3. Rewrite the manifest: the artifact declares real semver ranges, because a
  //    profile's pnpm cannot read the `workspace:` protocol.
  const published = structuredClone(manifest)
  for (const [name, spec] of Object.entries(published.dependencies ?? {})) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      published.dependencies[name] = spec.slice('workspace:'.length)
    }
  }
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(published, null, 2)}\n`, 'utf8')

  const measured = await measure(packageRoot)
  built.files = measured.files
  built.bytes = measured.bytes

  // 4. One tarball, npm layout (`package/` at the root).
  await mkdir(outDir, { recursive: true })
  const outFile = join(outDir, `${tag}.tgz`)
  run('tar', ['-czf', outFile, '-C', staging, 'package'])
  const bytes = (await stat(outFile)).size
  const digest = createHash('sha256').update(await readFile(outFile)).digest('hex')

  // 5. Verify from the produced artifact, not from the staging directory.
  const verifyDir = join(staging, 'verify')
  await mkdir(verifyDir, { recursive: true })
  run('tar', ['-xzf', outFile, '-C', verifyDir])
  for (const name of LAYERS) {
    await assertPackageComplete(join(verifyDir, 'package', 'node_modules', '@pseudo-agi', name), name)
  }
  for (const entry of LAYER_ENTRIES) {
    const text = await readFile(join(verifyDir, 'package', 'layers', `${entry}.js`), 'utf8')
    assert.match(text, new RegExp(`export \\* from '@pseudo-agi/${entry}'`), `${entry}.js must re-export its package`)
  }
  const patch = await readFile(join(verifyDir, 'package', 'cordis.patch.yml'), 'utf8')
  for (const entry of LAYER_ENTRIES) {
    assert.match(patch, new RegExp(`name: '@pseudo-agi/bundle/layers/${entry}'`), `patch must name the ${entry} layer`)
  }

  await writeFile(join(outDir, `${tag}.manifest.json`), `${JSON.stringify({
    file: `${tag}.tgz`,
    version,
    bytes,
    sha256: digest,
    unpacked: { files: built.files, bytes: built.bytes },
    packages: built.packages,
    layers: LAYER_ENTRIES,
  }, null, 2)}\n`, 'utf8')

  console.log(`\npacked ${relative(projectRoot, outFile) || outFile}`)
  console.log(`  ${bytes} bytes, sha256 ${digest.slice(0, 16)}…`)
  console.log(`  carries ${LAYERS.length} packages, ${built.files} files / ${built.bytes} bytes unpacked`)
  console.log(`  install: pnpm add ${outFile}`)
  console.log('  online: serve the .tgz over http(s) and install that URL, or publish it to a registry.')
} finally {
  await rm(staging, { recursive: true, force: true })
}
