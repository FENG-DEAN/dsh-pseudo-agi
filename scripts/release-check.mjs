/**
 * Release preflight: what would actually be published, and is it what we mean to
 * publish.
 *
 * Three mistakes this exists for, all already observed in this project:
 *
 *   1. `tsc` never deletes, so a removed source file left
 *      `pseudo-agi-scaffold/lib/router.js` behind and `files` shipped it.
 *   2. `pnpm pack` on a bundle with `bundledDependencies` expands the workspace
 *      symlinks and drags host packages in
 *      (`node_modules/@deepseek-ai/cosmokit/LICENSE`) — so the bundle carries a
 *      committed `vendor/` copy instead, and must stay dependency-free.
 *   3. A vendored copy that nobody rebuilds silently ships yesterday's code, so
 *      every vendored file is compared byte-for-byte with the built package.
 *
 * A tarball is the only place those become visible, so this runs `pnpm pack` for
 * the six layer packages and `pack-bundle` for the artifact, then reads both
 * archive listings.
 *
 * Run with: pnpm release-check
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmCommand } from './lib/pnpm-command.mjs'

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

/** What each layer contributes to the bundle's committed `vendor/` copy. */
const VENDOR_SOURCES = {
  store: ['index.js', 'index.d.ts'],
  memory: ['lib'],
  tools: ['lib'],
  scaffold: ['lib'],
  governance: ['lib'],
  panel: ['index.js', 'client.js'],
}

/** Entry file each vendored layer exposes, for artifact content checks. */
const VENDOR_ENTRIES = {
  store: 'index.js',
  memory: 'lib/index.js',
  tools: 'lib/index.js',
  scaffold: 'lib/index.js',
  governance: 'lib/index.js',
  panel: 'index.js',
}

/** Patch rows, in order; each must resolve through a bundle subpath. */
const LAYER_ENTRIES = ['memory', 'tools', 'scaffold', 'governance', 'panel']

/**
 * Tarball entries that must never appear: build leftovers, tests, local state,
 * and — because a package tarball is rooted at its own directory — anything from
 * the repository root. `AGI_STATE.md` and `.pseudo-agi/` hold the working notes
 * and the memory records of one machine; they are not publishable material.
 */
const FORBIDDEN = [
  /\.map$/,
  /(^|\/)dist\//,
  /(^|\/)test\b/,
  /(^|\/)spec\b/,
  /\.tsbuildinfo$/,
  /(^|\/)tmp\//,
  /(^|\/)store\.json$/,
  /^\.\.\//,
  /^AGI_STATE\.md$/,
  /^\.pseudo-agi\//,
  /^docs\//,
  /^scripts\//,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig\.base\.json$/,
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

/** Every file under `dir`, as paths relative to it, sorted. */
async function walkRelative(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await walkRelative(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

/** SHA-256 of one file. */
async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
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

  console.log('\n[3b] 组合包是自包含的（vendor 已提交、产物开箱即用）')

  await check('vendor 里的六个包与各自源码编译产物逐文件一致', async () => {
    for (const [name, entries] of Object.entries(VENDOR_SOURCES)) {
      const source = join(packagesDir, `pseudo-agi-${name}`)
      const vendored = join(packagesDir, 'pseudo-agi-bundle', 'vendor', 'node_modules', '@pseudo-agi', name)
      const expected = new Set(['package.json', 'README.md', 'LICENSE'])
      for (const item of entries) {
        const path = join(source, item)
        const info = await stat(path)
        if (info.isDirectory()) {
          for (const file of await walkRelative(path)) {
            if (!file.endsWith('.map')) expected.add(`${item}/${file}`)
          }
        } else {
          expected.add(item)
        }
      }
      const actual = new Set(await walkRelative(vendored))
      assert.deepEqual([...actual].sort(), [...expected].sort(),
        `${name}: vendor differs from the built package (run pnpm vendor)`)
      for (const file of expected) {
        const sourceHash = await hashFile(join(source, file))
        const vendoredHash = await hashFile(join(vendored, file))
        assert.equal(vendoredHash, sourceHash, `${name}/${file}: vendored copy is stale (run pnpm vendor)`)
      }
    }
  })

  await check('client.js 由 panel 客户端生成，只差 factory id', async () => {
    const bundleClient = await readFile(join(packagesDir, 'pseudo-agi-bundle', 'client.js'), 'utf8')
    const panelClient = await readFile(join(packagesDir, 'pseudo-agi-panel', 'client.js'), 'utf8')
    assert.equal(bundleClient, panelClient.replace("id: '@pseudo-agi/panel'", "id: '@pseudo-agi/bundle'"))
  })

  await check('组合包不声明依赖（安装时无需解析任何包名）', async () => {
    const manifest = JSON.parse(await readFile(join(packagesDir, 'pseudo-agi-bundle', 'package.json'), 'utf8'))
    assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'bundle must stay dependency-free')
    assert.equal(manifest.bundledDependencies, undefined, 'vendored files replace bundledDependencies')
  })

  run(command, [...args, 'run', 'pack-bundle', '--', '--out', distDir], { cwd: projectRoot })
  const artifactFile = (await readdir(distDir)).find(entry => entry.endsWith('.tgz'))
  assert.ok(artifactFile, 'pack-bundle produced no tarball')
  artifact = join(distDir, artifactFile)
  artifactManifest = tarballManifest(artifact)

  await check('产物携带 vendor 六包、五行入口、client.js 与 LICENSE', async () => {
    const entries = tarballEntries(artifact)
    const required = ['package.json', 'README.md', 'LICENSE', 'index.js', 'cordis.patch.yml', 'client.js',
      ...LAYER_ENTRIES.map(layer => `layers/${layer}.js`),
      ...Object.entries(VENDOR_ENTRIES).map(([name, entry]) => `vendor/node_modules/@pseudo-agi/${name}/${entry}`)]
    for (const entry of required) assert.ok(entries.includes(entry), `missing ${entry}`)
    console.log(`       → ${entries.length} files, ${(await stat(artifact)).size} bytes`)
  })

  await check('产物里没有宿主包、没有 source map、没有构建残留', () => {
    for (const entry of tarballEntries(artifact)) {
      for (const pattern of [...FORBIDDEN, /node_modules\/@deepseek-ai\//]) {
        assert.doesNotMatch(entry, pattern, `forbidden entry in artifact: ${entry}`)
      }
    }
  })

  await check('产物 manifest 用真实 semver，且声明为公开包', () => {
    for (const [dependency, spec] of Object.entries(artifactManifest.dependencies ?? {})) {
      assert.ok(!String(spec).startsWith('workspace:'), `dependencies.${dependency} still uses the workspace protocol`)
    }
    assert.equal(artifactManifest.publishConfig?.access, 'public')
    assert.equal(artifactManifest.dependencies, undefined, 'artifact must not carry dependencies')
  })

  await check('prepublishOnly 检查生成物存在（缺 vendor 就拒绝发布）', async () => {
    const manifest = JSON.parse(await readFile(join(packagesDir, 'pseudo-agi-bundle', 'package.json'), 'utf8'))
    assert.equal(manifest.scripts?.prepublishOnly, 'node ../../scripts/assert-vendored.mjs')
    for (const file of ['client.js', 'vendor/node_modules/@pseudo-agi/store/index.js']) {
      await stat(join(packagesDir, 'pseudo-agi-bundle', file))
    }
  })

  console.log('\n[4] 组合包接线')

  await check('patch 五行都指向包内子路径', async () => {
    const patch = await readFile(join(packagesDir, 'pseudo-agi-bundle', 'cordis.patch.yml'), 'utf8')
    const names = [...patch.matchAll(/^\s*name: '([^']+)'/gm)].map(match => match[1])
    assert.deepEqual(names, LAYER_ENTRIES.map(layer => `@pseudo-agi/bundle/layers/${layer}`))
  })

  await check('每个 layer 入口用相对路径指向 vendor，没有裸包名', async () => {
    for (const layer of LAYER_ENTRIES) {
      const text = await readFile(join(packagesDir, 'pseudo-agi-bundle', 'layers', `${layer}.js`), 'utf8')
      const target = /export \* from '(\.\.\/vendor\/[^']+)'/.exec(text)?.[1]
      assert.ok(target, `${layer}.js must re-export its vendored copy by relative path`)
      assert.doesNotMatch(text, /from '@pseudo-agi\//, `${layer}.js must not import a bare package name`)
      await stat(join(packagesDir, 'pseudo-agi-bundle', 'layers', target))
    }
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
