/**
 * Release preflight: what would actually be published, and is it what we mean to
 * publish.
 *
 * Two mistakes this exists for, both already observed in this project:
 *
 *   1. `tsc` never deletes, so a removed source file left
 *      `pseudo-agi-scaffold/lib/router.js` behind and `files` shipped it.
 *   2. `pnpm pack` on the bundle expands `bundledDependencies` through the
 *      workspace symlinks and drags host packages in
 *      (`node_modules/@deepseek-ai/cosmokit/LICENSE`). The publishable bundle is
 *      therefore the `pack-bundle` artifact, never the source directory.
 *
 * A tarball is the only place those become visible, so this runs `pnpm pack` for
 * the six layer packages and `pack-bundle` for the artifact, then reads both
 * archive listings.
 *
 * Run with: pnpm release-check
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(projectRoot, 'packages')

/** Layer packages published on their own, with the entry files a consumer needs. */
const PUBLISHED = {
  'pseudo-agi-memory': { entries: ['lib/index.js', 'lib/index.d.ts'] },
  'pseudo-agi-tools': { entries: ['lib/index.js', 'lib/index.d.ts'] },
  'pseudo-agi-scaffold': { entries: ['lib/index.js', 'lib/index.d.ts'] },
  'pseudo-agi-governance': { entries: ['lib/index.js', 'lib/index.d.ts'] },
  'pseudo-agi-panel': { entries: ['index.js', 'client.js'] },
  'pseudo-agi-store': { entries: ['index.js', 'index.d.ts'] },
}

/** Packages the bundle artifact carries inside its node_modules. */
const CARRIED = [
  '@pseudo-agi/governance',
  '@pseudo-agi/memory',
  '@pseudo-agi/panel',
  '@pseudo-agi/scaffold',
  '@pseudo-agi/store',
  '@pseudo-agi/tools',
]

/** Patch rows, in order; each must resolve through a bundle subpath. */
const LAYER_ENTRIES = ['memory', 'tools', 'scaffold', 'governance', 'panel']

/** Tarball entries that must never appear: build leftovers, tests, local state. */
const FORBIDDEN = [
  /\.map$/,
  /(^|\/)dist\//,
  /(^|\/)test\b/,
  /(^|\/)spec\b/,
  /\.tsbuildinfo$/,
  /(^|\/)tmp\//,
  /(^|\/)store\.json$/,
]

let checks = 0
const failures = []

async function check(name, body) {
  try {
    await body()
    checks++
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

function pnpmCommand() {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.length > 0) return { command: process.execPath, args: [execpath] }
  return { command: 'pnpm', args: [] }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

/** Entries of one tarball, sorted, with the leading `package/` kept off for matching. */
function tarballEntries(tarball) {
  return run('tar', ['-tzf', tarball]).split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.endsWith('/'))
    .map(line => line.replace(/^package\//, ''))
    .sort()
}

/** Read one `package.json` inside a tarball without unpacking the rest. */
function tarballManifest(tarball) {
  return JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']))
}

const staging = await mkdtemp(join(tmpdir(), 'pseudo-agi-release-'))
const packDir = join(staging, 'packs')
const distDir = join(staging, 'dist')
await mkdir(packDir, { recursive: true })
await mkdir(distDir, { recursive: true })
const { command, args } = pnpmCommand()

/** name → { manifest, entries, bytes } for the six layer packages. */
const packed = {}
let artifact
let artifactManifest

try {
  console.log('\n[1] 版本与发布元数据')

  const manifests = {}
  for (const name of [...Object.keys(PUBLISHED), 'pseudo-agi-bundle']) {
    manifests[name] = JSON.parse(await readFile(join(packagesDir, name, 'package.json'), 'utf8'))
  }
  const versions = new Set(Object.values(manifests).map(manifest => manifest.version))

  await check('七个包版本一致', () => {
    assert.equal(versions.size, 1, `mixed versions: ${[...versions].join(', ')}`)
    console.log(`       → ${[...versions][0]}`)
  })

  for (const [name, manifest] of Object.entries(manifests)) {
    await check(`${name} 的发布元数据完整`, () => {
      assert.equal(manifest.publishConfig?.access, 'public', 'publishConfig.access must be "public" (scoped package)')
      assert.ok(manifest.engines?.node, 'engines.node is required')
      assert.ok(typeof manifest.author === 'string' && manifest.author.length > 0, 'author is required')
      assert.equal(manifest.license, 'MIT')
      assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 3, 'keywords should describe the package')
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'files must be an allow-list')
      assert.equal(manifest.private, undefined, 'private must not be set')
    })
    await check(`${name} 目录内有 LICENSE`, async () => {
      const text = await readFile(join(packagesDir, name, 'LICENSE'), 'utf8')
      assert.match(text, /MIT License/)
      assert.match(text, /Permission is hereby granted/)
    })
  }

  console.log('\n[2] 构建产物与源码一致（stale 检测）')

  for (const name of ['pseudo-agi-memory', 'pseudo-agi-tools', 'pseudo-agi-scaffold', 'pseudo-agi-governance']) {
    await check(`${name} 的 lib 没有源码之外的编译产物`, async () => {
      const sources = new Set((await readdir(join(packagesDir, name, 'src')))
        .filter(file => file.endsWith('.ts')).map(file => file.slice(0, -3)))
      const compiled = (await readdir(join(packagesDir, name, 'lib')))
        .filter(file => file.endsWith('.js')).map(file => file.slice(0, -3))
      const stale = compiled.filter(file => !sources.has(file))
      assert.deepEqual(stale, [], `stale compiled files (run pnpm clean:build): ${stale.join(', ')}`)
    })
  }

  console.log('\n[3] 六个层的 tarball')

  for (const name of Object.keys(PUBLISHED)) {
    await check(`${name} pack 出的 tarball 只含该含的东西`, async () => {
      run(command, [...args, '-C', join(packagesDir, name), 'pack', '--pack-destination', packDir], { cwd: projectRoot })
      const file = (await readdir(packDir)).find(entry => entry.startsWith(`${name}-`) && entry.endsWith('.tgz'))
      assert.ok(file, 'pack produced no tarball')
      const tarball = join(packDir, file)
      const entries = tarballEntries(tarball)
      const manifest = tarballManifest(tarball)
      packed[name] = { manifest, entries, bytes: (await stat(tarball)).size }

      for (const required of ['package.json', 'README.md', 'LICENSE', ...PUBLISHED[name].entries]) {
        assert.ok(entries.includes(required), `missing ${required}`)
      }
      for (const entry of entries) {
        for (const pattern of [...FORBIDDEN, /(^|\/)node_modules\//]) {
          assert.doesNotMatch(entry, pattern, `forbidden entry in tarball: ${entry}`)
        }
      }
      for (const [dependency, spec] of Object.entries(manifest.dependencies ?? {})) {
        assert.ok(!String(spec).startsWith('workspace:'), `dependencies.${dependency} still uses the workspace protocol`)
      }
      console.log(`       → ${entries.length} files, ${packed[name].bytes} bytes`)
    })
  }

  console.log('\n[3b] 组合包产物（pack-bundle，不是 pnpm pack）')

  run(command, [...args, 'run', 'pack-bundle', '--', '--no-build', '--out', distDir], { cwd: projectRoot })
  const artifactFile = (await readdir(distDir)).find(entry => entry.endsWith('.tgz'))
  assert.ok(artifactFile, 'pack-bundle produced no tarball')
  artifact = join(distDir, artifactFile)
  artifactManifest = tarballManifest(artifact)

  await check('产物自包含六个实现包、五行入口与面板客户端', async () => {
    const entries = tarballEntries(artifact)
    const required = ['package.json', 'README.md', 'LICENSE', 'index.js', 'cordis.patch.yml', 'client.js',
      ...LAYER_ENTRIES.map(layer => `layers/${layer}.js`),
      ...CARRIED.map(name => `node_modules/${name}/package.json`)]
    for (const entry of required) assert.ok(entries.includes(entry), `missing ${entry}`)
    console.log(`       → ${entries.length} files, ${(await stat(artifact)).size} bytes`)
  })

  await check('产物里没有宿主包、没有构建残留', () => {
    for (const entry of tarballEntries(artifact)) {
      for (const pattern of [...FORBIDDEN, /node_modules\/@deepseek-ai\//]) {
        assert.doesNotMatch(entry, pattern, `forbidden entry in artifact: ${entry}`)
      }
    }
  })

  await check('产物 manifest 用真实 semver，且 bundled 列表恰好覆盖六个包', () => {
    for (const [dependency, spec] of Object.entries(artifactManifest.dependencies ?? {})) {
      assert.ok(!String(spec).startsWith('workspace:'), `dependencies.${dependency} still uses the workspace protocol`)
    }
    assert.equal(artifactManifest.publishConfig?.access, 'public')
    assert.deepEqual([...artifactManifest.bundledDependencies].sort(), [...CARRIED].sort())
  })

  await check('源码目录被 prepublishOnly 挡住（不能直接 pnpm publish）', async () => {
    const manifest = JSON.parse(await readFile(join(packagesDir, 'pseudo-agi-bundle', 'package.json'), 'utf8'))
    assert.equal(manifest.scripts?.prepublishOnly, 'node ../../scripts/assert-packed-bundle.mjs')
    const exists = await stat(join(packagesDir, 'pseudo-agi-bundle', 'client.js')).then(() => true, () => false)
    assert.equal(exists, false, 'packages/pseudo-agi-bundle/client.js must be generated, not committed')
  })

  console.log('\n[4] 组合包接线')

  await check('patch 五行都指向包内子路径', async () => {
    const patch = await readFile(join(packagesDir, 'pseudo-agi-bundle', 'cordis.patch.yml'), 'utf8')
    const names = [...patch.matchAll(/^\s*name: '([^']+)'/gm)].map(match => match[1])
    assert.deepEqual(names, LAYER_ENTRIES.map(layer => `@pseudo-agi/bundle/layers/${layer}`))
  })

  await check('产物声明了 patch 与客户端半侧', () => {
    assert.equal(artifactManifest.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.equal(artifactManifest.dsh?.client?.platform, 'web')
    assert.ok(artifactManifest.exports?.['./client'], 'exports must expose ./client')
  })

  console.log('\n[5] 发布说明')

  const artifactBytes = (await stat(artifact)).size
  const total = Object.values(packed).reduce((sum, entry) => sum + entry.bytes, 0) + artifactBytes
  console.log(`  ${Object.keys(packed).length} 层包 + 1 组合包产物，合计 ${(total / 1024).toFixed(0)} KiB`)
  for (const [name, entry] of Object.entries(packed)) {
    console.log(`  ${name.padEnd(24)} ${String(entry.bytes).padStart(7)} B  ${entry.entries.length} files`)
  }
  console.log(`  ${'pseudo-agi-bundle'.padEnd(24)} ${String(artifactBytes).padStart(7)} B  ${tarballEntries(artifact).length} files`)
  console.log('  next: docs/publishing.md')
} finally {
  await rm(staging, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
