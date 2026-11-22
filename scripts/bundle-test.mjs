/**
 * Distribution test: prove that the whole pseudo-AGI installs from ONE spec.
 *
 * The problem this pins down: the plugin loader resolves a patch row's `name`
 * from the *profile's* package scope (`import.meta.resolve` anchored at
 * `.cordis/resolve.mjs`), and the plugin manager takes one spec per install. A
 * bundle that merely depends on the five layers therefore fails with
 * `ERR_PNPM_FETCH_404`, because `@pseudo-agi/*` is on no registry.
 *
 * Covered here:
 *   1. the artifact carries its six packages and stays consistent with its manifest;
 *   2. one local tarball spec installs the whole thing;
 *   3. every patch row resolves profile → `layers/*.js` → bundled package;
 *   4. the browser half is present and declares the bundle's own factory id;
 *   5. the same tarball installs over **http**, which is what "online" means.
 *
 * Run with: pnpm bundle-test   (or: node scripts/bundle-test.mjs)
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(projectRoot, 'packages', 'pseudo-agi-bundle')

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

/**
 * Asynchronous sibling of {@link run}. Required for the HTTP step: the tarball
 * server lives in this process, and a synchronous child would block the event
 * loop that has to answer pnpm's HEAD request.
 */
async function runAsync(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', ...options })
  return stdout
}

const LAYERS = ['memory', 'tools', 'scaffold', 'governance', 'panel']
const CARRIED = {
  store: ['index.js', 'index.d.ts'],
  memory: ['lib/index.js'],
  tools: ['lib/index.js'],
  scaffold: ['lib/index.js'],
  governance: ['lib/index.js'],
  panel: ['index.js', 'client.js'],
}

const work = await mkdtemp(join(tmpdir(), 'pseudo-agi-dist-'))
const outDir = join(work, 'dist')
const server = createServer()

try {
  console.log('\n[1] 自包含产物')

  const { command, args } = pnpmCommand()
  run(command, [...args, 'run', 'pack-bundle', '--', '--no-build', '--out', outDir], { cwd: projectRoot })

  const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
  const tag = `pseudo-agi-bundle-${manifest.version}`
  const tarball = join(outDir, `${tag}.tgz`)

  await check('产物与清单一致（大小 / sha256 / 六个包）', async () => {
    const record = JSON.parse(await readFile(join(outDir, `${tag}.manifest.json`), 'utf8'))
    const bytes = (await stat(tarball)).size
    const digest = createHash('sha256').update(await readFile(tarball)).digest('hex')
    assert.equal(record.bytes, bytes)
    assert.equal(record.sha256, digest)
    assert.deepEqual(Object.keys(record.packages).sort(), Object.keys(CARRIED).sort())
    for (const [name, version] of Object.entries(record.packages)) assert.equal(version, manifest.version, name)
    console.log(`       → ${bytes} bytes, ${record.unpacked.files} files unpacked`)
  })

  console.log('\n[2] 一条 spec 安装（本地 tarball）')

  const localConsumer = join(work, 'local')
  await mkdir(localConsumer, { recursive: true })
  await writeFile(join(localConsumer, 'package.json'), '{"name":"consumer-local","private":true,"type":"module"}\n', 'utf8')
  let localInstall
  await check('pnpm add <tgz> 退出码 0，且不再访问 registry 取兄弟包', async () => {
    localInstall = run(command, [...args, 'add', tarball, '--ignore-scripts'], { cwd: localConsumer })
    assert.match(localInstall, /@pseudo-agi\/bundle/)
    assert.doesNotMatch(localInstall, /ERR_PNPM_FETCH_404/)
  })
  await check('安装后携带六个包（pnpm 保留 tarball 内 node_modules）', async () => {
    const nested = join(localConsumer, 'node_modules', '@pseudo-agi', 'bundle', 'node_modules', '@pseudo-agi')
    const names = (await readdir(nested)).sort()
    assert.deepEqual(names, Object.keys(CARRIED).sort())
    for (const [name, files] of Object.entries(CARRIED)) {
      for (const file of files) await stat(join(nested, name, file))
    }
  })
  await check('bundle 声明组合包 patch 与客户端半侧', async () => {
    const installed = JSON.parse(await readFile(
      join(localConsumer, 'node_modules', '@pseudo-agi', 'bundle', 'package.json'), 'utf8'))
    assert.equal(installed.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(installed.dsh.client.platform, 'web')
    assert.equal(installed.dsh.client.immediately, true)
    assert.ok(Array.isArray(installed.dsh.client.inject) && installed.dsh.client.inject.length > 0)
    assert.equal(installed.dependencies['@pseudo-agi/memory'], '^0.1.0', 'workspace: protocol must be rewritten')
  })

  console.log('\n[3] patch 五行按 profile scope 解析到内置副本')

  const consumerRequire = createRequire(join(localConsumer, 'package.json'))
  await check('每个 layers/*.js 都能从 profile 解析，并转发到内置包', async () => {
    for (const layer of LAYERS) {
      const entry = consumerRequire.resolve(`@pseudo-agi/bundle/layers/${layer}`)
      assert.ok(entry.includes(join('bundle', 'layers')), `${layer}: unexpected entry ${entry}`)
      const text = await readFile(entry, 'utf8')
      assert.match(text, new RegExp(`export \\* from '@pseudo-agi/${layer}'`), `${layer}: missing re-export`)
      // Second hop: inside the bundle, the package name resolves to the carried copy.
      const inner = createRequire(entry).resolve(`@pseudo-agi/${layer}`)
      assert.ok(inner.includes(join('bundle', 'node_modules', '@pseudo-agi', layer)),
        `${layer}: resolved outside the bundle (${inner})`)
    }
  })
  await check('patch 只引用包内子路径，没有裸的 @pseudo-agi/<layer>', async () => {
    const patch = await readFile(join(localConsumer, 'node_modules', '@pseudo-agi', 'bundle', 'cordis.patch.yml'), 'utf8')
    const names = [...patch.matchAll(/^\s*name: '([^']+)'/gm)].map(match => match[1])
    assert.deepEqual(names, LAYERS.map(layer => `@pseudo-agi/bundle/layers/${layer}`))
  })
  await check('内置包之间的依赖也在 bundle 内解析（store 被三层共用）', () => {
    for (const owner of ['memory', 'tools', 'governance', 'panel']) {
      const from = join(localConsumer, 'node_modules', '@pseudo-agi', 'bundle', 'node_modules', '@pseudo-agi', owner, 'package.json')
      const resolved = createRequire(from).resolve('@pseudo-agi/store')
      assert.ok(resolved.includes(join('bundle', 'node_modules', '@pseudo-agi', 'store')),
        `${owner}: store resolved outside the bundle (${resolved})`)
    }
  })
  await check('开发形态（link）下同一套 patch 也能解析', () => {
    // A `link:` install has no nested copy: the re-export must reach the sibling
    // workspace packages through `packages/pseudo-agi-bundle/node_modules`.
    for (const layer of LAYERS) {
      const entry = join(bundleDir, 'layers', `${layer}.js`)
      const inner = createRequire(entry).resolve(`@pseudo-agi/${layer}`)
      assert.ok(inner.includes(`pseudo-agi-${layer}`), `${layer}: ${inner}`)
    }
  })

  console.log('\n[4] 面板客户端半侧')

  await check('bundle/client 可加载，且 factory id 是 @pseudo-agi/bundle', async () => {
    const clientPath = consumerRequire.resolve('@pseudo-agi/bundle/client')
    assert.match(clientPath, /bundle[\\/]client\.js$/)
    let registration
    const previous = globalThis.window
    globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
    try {
      await import(pathToFileURL(clientPath).href)
    } finally {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    }
    assert.ok(registration, 'client did not register')
    assert.equal(registration.id, '@pseudo-agi/bundle')
    assert.equal(typeof registration.factory, 'function')
  })
  await check('客户端内容与 panel 包一致（只差 factory id）', async () => {
    const bundleClient = await readFile(join(localConsumer, 'node_modules', '@pseudo-agi', 'bundle', 'client.js'), 'utf8')
    const panelClient = await readFile(join(localConsumer, 'node_modules', '@pseudo-agi', 'bundle', 'node_modules',
      '@pseudo-agi', 'panel', 'client.js'), 'utf8')
    assert.equal(bundleClient, panelClient.replace("id: '@pseudo-agi/panel'", "id: '@pseudo-agi/bundle'"))
  })

  console.log('\n[5] 在线安装（http tarball URL）')

  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const payload = await readFile(tarball)
  server.on('request', (request, response) => {
    if (request.url !== `/${tag}.tgz`) {
      response.writeHead(404)
      response.end()
      return
    }
    const headers = { 'content-type': 'application/octet-stream', 'content-length': payload.byteLength }
    // pnpm probes with HEAD first; a HEAD response must not carry a body.
    response.writeHead(200, headers)
    response.end(request.method === 'HEAD' ? undefined : payload)
  })

  const onlineConsumer = join(work, 'online')
  await mkdir(onlineConsumer, { recursive: true })
  await writeFile(join(onlineConsumer, 'package.json'), '{"name":"consumer-online","private":true,"type":"module"}\n', 'utf8')

  await check(`pnpm add http://127.0.0.1:<port>/${tag}.tgz 成功`, async () => {
    await runAsync(command, [...args, 'add', `http://127.0.0.1:${port}/${tag}.tgz`, '--ignore-scripts'],
      { cwd: onlineConsumer })
    const installed = join(onlineConsumer, 'node_modules', '@pseudo-agi', 'bundle')
    await stat(join(installed, 'cordis.patch.yml'))
    await stat(join(installed, 'client.js'))
    for (const name of Object.keys(CARRIED)) await stat(join(installed, 'node_modules', '@pseudo-agi', name, 'package.json'))
  })
  await check('在线装好后，五行同样能在该 profile 里解析', () => {
    const requireFromOnline = createRequire(join(onlineConsumer, 'package.json'))
    for (const layer of LAYERS) {
      const entry = requireFromOnline.resolve(`@pseudo-agi/bundle/layers/${layer}`)
      const inner = createRequire(entry).resolve(`@pseudo-agi/${layer}`)
      assert.ok(inner.includes(join('bundle', 'node_modules', '@pseudo-agi', layer)), `${layer}: ${inner}`)
    }
  })
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(work, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
