/**
 * Panel route test: drive the Host half's real `/state` handler with a fake
 * web server, against the real workspace files.
 *
 * The browser half cannot be tested without a browser, but everything the panel
 * renders comes through this one JSON route, so this is where the data contract
 * is pinned: shape, counts, and the two error branches.
 *
 * Run with: node scripts/panel-test.mjs
 */

import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../packages/pseudo-agi-memory/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const panel = await import('../packages/pseudo-agi-panel/index.js')

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

async function waitFor(label, predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${label}`)
}

/** Fake web server capturing the registered prefix route. */
let routePath = null
let routeHandler = null
const fakeWebServer = {
  register(options) {
    routePath = options.path
    routeHandler = options.handler
    return () => { routeHandler = null }
  },
}

const app = new Context()
app.plugin({ name: 'fake-web', apply(ctx) { ctx.provide('webServer', fakeWebServer) } })
const fork = app.plugin(panel, { workspaceRoot: 'D:/Doc/AIDoc/Dsh_dev/dsh_agi_dev' })
/** Later apps are declared up front so `finally` can dispose them. */
let fork2 = null
let fork3 = null
let fork4 = null

/** Call the handler and resolve with the response it produces. */
async function invoke(handler, method, url, headers = {}) {
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body ?? ''
      this.done?.()
    },
  }
  const done = new Promise(resolve => { response.done = resolve })
  await handler({ method, url, headers }, response)
  await done
  return response
}

/** Call the unauthenticated route captured from the first app. */
async function call(method, url, headers = {}) {
  return invoke(routeHandler, method, url, headers)
}

try {
  console.log('\n[1] 路由挂载')

  await check('注册了 /pseudo-agi/api 前缀路由', async () => {
    await waitFor('route', () => routeHandler !== null)
    assert.equal(routePath, '/pseudo-agi/api')
  })

  console.log('\n[2] GET /state 返回真实数据')

  let payload
  await check('200 + ok:true + JSON 内容类型', async () => {
    const response = await call('GET', '/pseudo-agi/api/state')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    payload = JSON.parse(response.body)
    assert.equal(payload.ok, true)
  })

  await check('分层计数与记忆总数一致', () => {
    const counts = payload.data.layers
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    assert.equal(payload.data.memoryTotal, total)
    assert.ok(total >= 1, `expected at least 1 committed record, got ${total}`)
  })

  await check('记忆按更新时间倒序，且带来源路径', () => {
    const memories = payload.data.memories
    assert.ok(memories.length > 0)
    for (const record of memories) {
      assert.ok(typeof record.id === 'string' && record.id.length > 0)
      assert.ok(typeof record.layer === 'string')
      assert.ok(record.path.endsWith('.md'))
      // `null` means live, a string means another record replaced it.
      assert.ok(record.supersededBy === null || typeof record.supersededBy === 'string', 'supersededBy must be exposed')
    }
    const sorted = [...memories].sort((left, right) =>
      String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    assert.deepEqual(memories.map(record => record.id), sorted.map(record => record.id))
  })

  await check('治理事件已进入面板（含 scaffold 与 memory 类）', () => {
    const kinds = new Set(payload.data.events.map(record => record.kind))
    assert.ok(kinds.has('step'), 'expected step events')
    assert.ok(kinds.has('scaffold'), 'expected scaffold events')
    assert.ok(kinds.has('tool'), 'expected tool events')
  })

  await check('工作台文本与工具数可见', () => {
    assert.match(payload.data.agiState ?? '', /AGI_STATE/)
    assert.ok(payload.data.agiState.length > 200)
    assert.ok(typeof payload.data.toolCount === 'number' || payload.data.toolCount === null)
  })

  console.log('\n[3] 错误分支')

  await check('未知 action → 404', async () => {
    const response = await call('GET', '/pseudo-agi/api/nope')
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(response.body).ok, false)
  })

  await check('非 GET → 405', async () => {
    const response = await call('POST', '/pseudo-agi/api/state')
    assert.equal(response.status, 405)
  })

  console.log('\n[4] 浏览器会话鉴权')

  // A second app with a real secret: the panel must verify the signed cookie itself.
  const secretBytes = randomBytes(32)
  const b64url = value => value.toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const authority = '127.0.0.1:58891'
  const credentialRecord = { kind: 'grant', payload: { version: 1, secret: b64url(secretBytes) } }
  const fakeCredentials = {
    async readRecord(key) {
      return key === 'client-connection/browser-session' ? credentialRecord : undefined
    },
  }
  function mintCookie(secret, host, { expiresIn = 3_600_000 } = {}) {
    const now = Date.now()
    const payload = { version: 1, authority: host, issuedAt: now, expiresAt: now + expiresIn }
    const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
    const signature = b64url(createHmac('sha256', secret).update(body).digest())
    const name = `dsh-auth-${b64url(createHash('sha256').update(host).digest())}`
    return `${name}=v1.${body}.${signature}`
  }

  let authedHandler = null
  const authedWebServer = {
    register(options) {
      authedHandler = options.handler
      return () => { authedHandler = null }
    },
  }
  const app2 = new Context()
  app2.plugin({ name: 'fake-web-2', apply(ctx) { ctx.provide('webServer', authedWebServer) } })
  app2.plugin({ name: 'fake-credentials', apply(ctx) { ctx.provide('credentials', fakeCredentials) } })
  fork2 = app2.plugin(panel, { workspaceRoot: 'D:/Doc/AIDoc/Dsh_dev/dsh_agi_dev' })
  await waitFor('authenticated route', () => authedHandler !== null)

  await check('带有效 cookie → 200', async () => {
    const response = await invoke(authedHandler, 'GET', '/pseudo-agi/api/state', {
      host: authority,
      cookie: mintCookie(secretBytes, authority),
    })
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).ok, true)
  })

  await check('无 cookie → 401', async () => {
    const response = await invoke(authedHandler, 'GET', '/pseudo-agi/api/state', { host: authority })
    assert.equal(response.status, 401)
    assert.equal(JSON.parse(response.body).ok, false)
  })

  await check('伪造签名 → 401', async () => {
    const response = await invoke(authedHandler, 'GET', '/pseudo-agi/api/state', {
      host: authority,
      cookie: mintCookie(randomBytes(32), authority),
    })
    assert.equal(response.status, 401)
  })

  await check('过期 cookie → 401', async () => {
    const response = await invoke(authedHandler, 'GET', '/pseudo-agi/api/state', {
      host: authority,
      cookie: mintCookie(secretBytes, authority, { expiresIn: -1_000 }),
    })
    assert.equal(response.status, 401)
  })

  await check('cookie 绑定的 authority 与请求 host 不符 → 401', async () => {
    const response = await invoke(authedHandler, 'GET', '/pseudo-agi/api/state', {
      host: authority,
      cookie: mintCookie(secretBytes, '127.0.0.1:1'),
    })
    assert.equal(response.status, 401)
  })

  console.log('\n[5] 知识库换位置后，面板跟随指针')

  const tmpRoot = await mkdtemp(join(tmpdir(), 'pseudo-agi-panel-'))
  const tmpWs = join(tmpRoot, 'ws')
  const tmpKb = join(tmpRoot, 'kb')
  await mkdir(join(tmpKb, 'memory', 'semantic'), { recursive: true })
  await mkdir(join(tmpKb, 'governance'), { recursive: true })
  await writeFile(join(tmpKb, 'memory', 'semantic', 'mem-moved.md'),
    '---\nid: "mem-moved"\nlayer: "semantic"\ntitle: "搬家后的记录"\nconfidence: 0.9\n'
    + 'updatedAt: "2026-11-23T00:00:00.000Z"\n---\n\n# 搬家后的记录\n', 'utf8')
  await writeFile(join(tmpKb, 'governance', 'session-moved.jsonl'),
    '{"at":"2026-11-23T00:00:00.000Z","sessionId":"s","kind":"step","detail":{"turn":1,"step":1,"messages":1}}\n', 'utf8')
  await writeFile(join(tmpKb, 'working.md'), '# 工作记忆摘要\n', 'utf8')
  await mkdir(join(tmpWs, '.pseudo-agi'), { recursive: true })
  await writeFile(join(tmpWs, '.pseudo-agi', 'store.json'),
    JSON.stringify({ version: 1, root: tmpKb, movedFrom: join(tmpWs, '.pseudo-agi') }), 'utf8')
  await writeFile(join(tmpWs, 'AGI_STATE.md'), '# AGI_STATE 测试\n', 'utf8')

  let movedHandler = null
  const movedWebServer = {
    register(options) {
      movedHandler = options.handler
      return () => { movedHandler = null }
    },
  }
  const app3 = new Context()
  app3.plugin({ name: 'fake-web-3', apply(ctx) { ctx.provide('webServer', movedWebServer) } })
  fork3 = app3.plugin(panel, { workspaceRoot: tmpWs })
  await waitFor('moved route', () => movedHandler !== null)

  await check('面板从指针指向的新根读记忆与日志', async () => {
    const response = await invoke(movedHandler, 'GET', '/pseudo-agi/api/state')
    assert.equal(response.status, 200)
    const data = JSON.parse(response.body).data
    assert.equal(data.store.source, 'pointer')
    assert.equal(data.store.root, tmpKb)
    assert.equal(data.store.warning, null)
    assert.equal(data.layers.semantic, 1)
    assert.ok(data.memories.some(record => record.id === 'mem-moved'))
    assert.ok(data.events.some(record => record.kind === 'step'))
    assert.match(data.workingDigest ?? '', /工作记忆摘要/)
    // AGI_STATE.md 是工程状态，留在工作区根，不跟着知识库搬。
    assert.match(data.agiState ?? '', /AGI_STATE 测试/)
  })

  await check('指针损坏时面板回退配置默认位置并暴露 warning', async () => {
    await writeFile(join(tmpWs, '.pseudo-agi', 'store.json'), '{ broken', 'utf8')
    let brokenHandler = null
    const brokenWebServer = {
      register(options) {
        brokenHandler = options.handler
        return () => { brokenHandler = null }
      },
    }
    const app4 = new Context()
    app4.plugin({ name: 'fake-web-4', apply(ctx) { ctx.provide('webServer', brokenWebServer) } })
    fork4 = app4.plugin(panel, { workspaceRoot: tmpWs })
    try {
      await waitFor('broken route', () => brokenHandler !== null)
      const response = await invoke(brokenHandler, 'GET', '/pseudo-agi/api/state')
      assert.equal(response.status, 200)
      const data = JSON.parse(response.body).data
      assert.equal(data.store.source, 'config')
      assert.equal(data.store.root, join(tmpWs, '.pseudo-agi'))
      assert.match(String(data.store.warning), /not valid JSON/)
      assert.equal(data.layers.semantic, 0)
    } finally {
      await fork4.dispose().catch(() => {})
    }
  })

  await rm(tmpRoot, { recursive: true, force: true })

  console.log('\n[6] 卸载后路由撤销')

  await check('dispose 后 handler 清空', async () => {
    await fork.dispose()
    await fork2.dispose()
    await fork3.dispose()
    await waitFor('route gone', () => routeHandler === null && authedHandler === null && movedHandler === null)
  })
} finally {
  for (const item of [fork, fork2, fork3, fork4]) {
    try { await item?.dispose() } catch { /* already disposed */ }
  }
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
