/**
 * Cordis-level integration test with REAL harness services.
 *
 * It stands up a real `@deepseek-ai/cordis` context and loads the real
 * `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-tools` plugins, then
 * loads the four pseudo-AGI layers through `ctx.plugin()`. That matters because
 * `ToolsService.register()` binds its disposer to the *calling* fiber through
 * Cordis' tracker — a hand-written stub cannot reproduce that, and the unload
 * assertions below depend on it.
 *
 * Run with: node scripts/load-test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../packages/pseudo-agi-memory/package.json', import.meta.url))
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href)

const { Context } = await load('@deepseek-ai/cordis')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { ToolsService } = await load('@deepseek-ai/dsh-tools')

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

function resolveConfig(schema, input) {
  const result = schema['~standard'].validate(input)
  if (result.issues) throw new Error(`invalid config: ${JSON.stringify(result.issues)}`)
  return result.value
}

async function waitFor(label, predicate, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${label}`)
}

const workspace = await mkdtemp(join(tmpdir(), 'pseudo-agi-load-'))
await mkdir(join(workspace, 'docs'), { recursive: true })
await writeFile(join(workspace, 'docs', 'approval.md'), '# 审批\n\n写操作必须先经过审批。\n', 'utf8')

const app = new Context()
const harnessForks = []
harnessForks.push(app.plugin(SystemPrompt, { includeHarnessIdentity: true }))
await waitFor('systemPrompt service', () => app.get('systemPrompt') !== undefined)
harnessForks.push(app.plugin(ToolsService, {}))
await waitFor('tools service', () => app.get('tools') !== undefined)
// Prompt assembly asks the selected executor to describe its tools, so a stub
// executor is required even though this test never dispatches a model tool call.
app.tools.setExecutor({
  describe: definitions => ({
    schemas: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })),
  }),
  execute: async () => ({ results: [] }),
})

const memory = await import('../packages/pseudo-agi-memory/lib/index.js')
const tools = await import('../packages/pseudo-agi-tools/lib/index.js')
const controller = await import('../packages/pseudo-agi-controller/lib/index.js')
const governance = await import('../packages/pseudo-agi-governance/lib/index.js')

const forks = []
const memoryConfig = resolveConfig(memory.Config, {
  workspaceRoot: workspace,
  root: join(workspace, 'memory'),
  maxInjectTokens: 200,
})
const toolsConfig = resolveConfig(tools.Config, { workspaceRoot: workspace, knowledgeRoots: ['docs'] })
const controllerConfig = resolveConfig(controller.Config, { injectPerTurn: 2 })
const governanceConfig = resolveConfig(governance.Config, { root: join(workspace, 'governance') })

const toolNames = () => app.tools.definitions().map(definition => definition.name).sort()

try {
  console.log('\n[1] 真实服务下逐层加载')

  await check('基础服务就绪（systemPrompt + tools）', () => {
    assert.equal(typeof app.systemPrompt.assemble, 'function')
    assert.equal(typeof app.tools.register, 'function')
    assert.deepEqual(toolNames(), [])
  })

  await check('memory 加载：4 个工具 + 1 个 prompt context', async () => {
    forks.push(app.plugin(memory, memoryConfig))
    await waitFor('memory tools', () => toolNames().length === 4)
    assert.deepEqual(toolNames(), ['memory_candidate', 'memory_commit', 'memory_forget', 'memory_recall'])
    // The tool's declared output schema must have passed ToolsService's own
    // JSON-Schema validation; register() throws otherwise.
    assert.equal(app.tools.get('memory_recall')?.output.schema.type, 'object')
  })

  await check('tools 加载：新增 3 个工具，guard 生效', async () => {
    forks.push(app.plugin(tools, toolsConfig))
    await waitFor('hand tools', () => toolNames().length === 7)
    assert.deepEqual(toolNames(), [
      'controlled_write', 'kb_read', 'kb_search',
      'memory_candidate', 'memory_commit', 'memory_forget', 'memory_recall',
    ])
    assert.match(String(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: '../x' } })?.reason), /路径越界/)
  })

  await check('controller 与 governance 加载后共 8 个工具', async () => {
    forks.push(app.plugin(controller, controllerConfig))
    forks.push(app.plugin(governance, governanceConfig))
    await waitFor('governance tool', () => toolNames().length === 8)
    assert.ok(toolNames().includes('governance_report'))
  })

  console.log('\n[2] guard 是单调否决（checkGuards 真实路径）')

  await check('越界路径 / 禁止段 / 禁止扩展名都被否决', () => {
    assert.match(String(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: '../escape.md' } })?.reason), /路径越界/)
    assert.match(String(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: '.git/config' } })?.reason), /被禁止的片段/)
    assert.match(String(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: 'run.ps1' } })?.reason), /禁止写入扩展名/)
  })

  await check('合法写入与只读工具不被否决', () => {
    assert.equal(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: 'docs/ok.md' } }), undefined)
    assert.equal(app.tools.checkGuards({ name: 'kb_search', arguments: { query: 'x' } }), undefined)
  })

  console.log('\n[3] 工具体真实执行')

  const signal = new AbortController().signal
  const makeExec = name => ({
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    name,
    arguments: {},
    signal,
    agent: { id: 'sess-test' },
    deferContext() {},
    concludeTurn() {},
  })
  const run = async (name, args) => {
    const definition = app.tools.get(name)
    assert.ok(definition, `tool ${name} must be registered`)
    return await definition.execute(args, makeExec(name))
  }

  await check('kb_search 命中并给出 path:line', async () => {
    const value = await run('kb_search', { query: '审批' })
    assert.equal(value.found, true)
    assert.ok(value.hits.every(hit => hit.path === 'docs/approval.md'))
    assert.ok(value.hits.some(hit => hit.line === 3))
  })

  await check('kb_search 未命中时 found=false 且有 note', async () => {
    const value = await run('kb_search', { query: '不存在的词zebra' })
    assert.equal(value.found, false)
    assert.match(value.note ?? '', /没找到/)
  })

  await check('kb_read 读真实内容，越界被拒', async () => {
    const value = await run('kb_read', { path: 'docs/approval.md' })
    assert.match(value.content, /写操作必须先经过审批/)
    await assert.rejects(run('kb_read', { path: '../outside.md' }), /路径越界/)
  })

  await check('controlled_write 落盘、追加、拒绝被禁扩展名', async () => {
    const first = await run('controlled_write', { path: 'notes/a.md', content: '第一行\n' })
    assert.equal(first.created, true)
    const second = await run('controlled_write', { path: 'notes/a.md', content: '第二行\n', mode: 'append' })
    assert.equal(second.created, false)
    assert.equal(await readFile(join(workspace, 'notes', 'a.md'), 'utf8'), '第一行\n第二行\n')
    await assert.rejects(run('controlled_write', { path: 'run.ps1', content: 'x' }), /禁止写入扩展名/)
  })

  console.log('\n[4] 记忆闭环')

  await check('candidate → commit → recall', async () => {
    const candidate = await run('memory_candidate', {
      layer: 'semantic',
      title: '写操作要先审批',
      body: '写文件必须经过审批，审批只覆盖一次调用。',
      evidence: [{ kind: 'file', ref: 'docs/approval.md' }],
      confidence: 0.85,
    })
    assert.equal(candidate.status, 'pending')
    await assert.rejects(run('memory_commit', { candidateId: 'nope' }), /找不到候选/)
    const committed = await run('memory_commit', { candidateId: candidate.candidateId })
    assert.equal(committed.status, 'committed')
    const recalled = await run('memory_recall', { query: '审批' })
    assert.equal(recalled.found, true)
    assert.ok(recalled.hits.some(hit => hit.id === committed.id))
    assert.ok(recalled.hits.every(hit => hit.evidence.length > 0), 'every hit must carry its sources')
  })

  await check('证据不存在时拒绝候选', async () => {
    await assert.rejects(run('memory_candidate', {
      layer: 'semantic',
      title: '无根据的断言',
      body: 'x',
      evidence: [{ kind: 'file', ref: 'docs/missing.md' }],
    }), /证据校验失败/)
  })

  console.log('\n[5] pre-step 注入 → prompt assembly')

  const agent = { id: 'sess-test' }
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: '查一下文档里审批是怎么做的' }],
    source: { kind: 'user' },
  }]

  await check('控制器把路由指令追加进本步消息', async () => {
    const decision = await app.waterfall(
      {},
      'agent/pre-step',
      { agent, messages, turn: 1, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }),
    )
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[1].source.kind, 'pseudo-agi-controller')
    assert.match(decision.messages[1].content[0].text, /路由=recall-first/)
  })

  await check('记忆注入块真的进入 system prompt 装配结果', async () => {
    const assembly = await app.systemPrompt.assemble({ agent, scope: agent })
    const context = assembly.contexts.find(entry => entry.name === 'pseudo-agi:memory')
    assert.ok(context, 'pseudo-agi:memory context must be assembled for this agent')
    assert.match(context.text, /当前长期记忆/)
    assert.match(context.text, /写操作要先审批/)
    assert.ok(!context.text.includes('{{'), 'memory text must not be interpolated')
  })

  await check('injectPerTurn 限制同轮注入次数', async () => {
    const once = { kind: 'enter', messages }
    for (const step of [1, 2]) {
      const decision = await app.waterfall({}, 'agent/pre-step',
        { agent, messages: once.messages, turn: 2, step, signal, modelSelection: { provider: 'p', model: 'm' } },
        async () => once)
      assert.equal(decision.messages.length, step <= 2 ? 2 : 1)
    }
    const third = await app.waterfall({}, 'agent/pre-step',
      { agent, messages: once.messages, turn: 2, step: 3, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => once)
    assert.equal(third.messages.length, 1, 'third step in the same turn must not inject')
  })

  console.log('\n[6] 卸载回收（真实 fiber 所有权）')

  await check('卸载 memory 后：工具、prompt context 同时消失，控制器仍工作', async () => {
    const memoryFork = forks[0]
    await memoryFork.dispose()
    await waitFor('memory tools gone', () => !toolNames().some(name => name.startsWith('memory_')))
    const assembly = await app.systemPrompt.assemble({ agent, scope: agent })
    assert.equal(assembly.contexts.find(entry => entry.name === 'pseudo-agi:memory'), undefined)
    const decision = await app.waterfall({}, 'agent/pre-step',
      { agent, messages, turn: 3, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }))
    assert.equal(decision.messages.length, 2, 'controller is a separate layer and keeps injecting')
    assert.match(decision.messages[1].content[0].text, /路由=recall-first/, 'kb_search still exists, so recall-first still applies')
  })

  await check('卸载 tools 后 guard 撤销，且控制器降级为 direct', async () => {
    await forks[1].dispose()
    await waitFor('hand tools gone', () => !toolNames().includes('controlled_write'))
    assert.equal(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: '../x' } }), undefined)
    const decision = await app.waterfall({}, 'agent/pre-step',
      { agent, messages, turn: 4, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }))
    assert.match(decision.messages[1].content[0].text, /路由=direct/)
    assert.match(decision.messages[1].content[0].text, /没有检索工具/)
  })

  await check('卸载 controller/governance 后只剩空注册表', async () => {
    for (const fork of forks.slice(2)) await fork.dispose()
    await waitFor('all tools gone', () => toolNames().length === 0)
    const decision = await app.waterfall({}, 'agent/pre-step',
      { agent, messages, turn: 9, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }))
    assert.equal(decision.messages.length, 1)
  })
} finally {
  for (const fork of [...forks, ...harnessForks]) {
    try {
      await fork.dispose()
    } catch {
      // Already disposed or mid-unload; the assertions above are what matter.
    }
  }
  await rm(workspace, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
