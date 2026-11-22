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
import { createRequire } from 'node:module'
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

/** Call the handler and resolve with the response it produces. */
async function call(method, url) {
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
  await routeHandler({ method, url }, response)
  await done
  return response
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

  console.log('\n[4] 卸载后路由撤销')

  await check('dispose 后 handler 清空', async () => {
    await fork.dispose()
    await waitFor('route gone', () => routeHandler === null)
  })
} finally {
  try { await fork.dispose() } catch { /* already disposed */ }
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
