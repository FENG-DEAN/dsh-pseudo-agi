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
import { existsSync } from 'node:fs'
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
/** Set by the `kb_store` group; removed in `finally` even when later checks fail. */
let movedParent = null
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
const scaffold = await import('../packages/pseudo-agi-scaffold/lib/index.js')
const governance = await import('../packages/pseudo-agi-governance/lib/index.js')

const forks = []
const memoryConfig = resolveConfig(memory.Config, {
  workspaceRoot: workspace,
  root: join(workspace, 'memory'),
  maxInjectTokens: 200,
})
// Route 1 acceptance: a second project root OUTSIDE the workspace, configured
// as an absolute knowledge root and an absolute write root. This is what proves
// "意识全局、记忆一份、手脚跨项目" — without it the arrays are only untested code.
const externalRoot = await mkdtemp(join(tmpdir(), 'pseudo-agi-external-'))
await writeFile(join(externalRoot, 'external.md'), '# 外部项目\n\n跨工作区标记词：external-marker\n', 'utf8')
// The Session's own project directory: a host may open a Session anywhere, and
// the hands must follow it with no path configuration at all.
const projectRoot = await mkdtemp(join(tmpdir(), 'pseudo-agi-project-'))
await mkdir(join(projectRoot, 'docs'), { recursive: true })
await writeFile(join(projectRoot, 'docs', 'session.md'), '# 会话项目\n\n会话项目标记词：session-marker\n', 'utf8')
harnessForks.push(app.plugin({
  name: 'fake-working-directory',
  apply(ctx) { ctx.provide('workingDirectory', { ensure: async () => projectRoot }) },
}))
const toolsConfig = resolveConfig(tools.Config, {
  workspaceRoot: workspace,
  knowledgeRoots: ['docs', externalRoot],
  writeRoots: ['.', externalRoot],
})
const scaffoldConfig = resolveConfig(scaffold.Config, { injectPerTurn: 1 })
const governanceConfig = resolveConfig(governance.Config, {
  workspaceRoot: workspace,
  root: join(workspace, 'governance'),
})

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

  await check('tools 加载：新增 4 个工具，guard 生效', async () => {
    forks.push(app.plugin(tools, toolsConfig))
    await waitFor('hand tools', () => toolNames().length === 8)
    assert.deepEqual(toolNames(), [
      'controlled_write', 'kb_read', 'kb_search', 'kb_store',
      'memory_candidate', 'memory_commit', 'memory_forget', 'memory_recall',
    ])
    assert.match(String(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: '../x' } })?.reason), /路径越界/)
  })

  await check('scaffold 与 governance 加载后共 9 个工具', async () => {
    forks.push(app.plugin(scaffold, scaffoldConfig))
    forks.push(app.plugin(governance, governanceConfig))
    await waitFor('governance tool', () => toolNames().length === 9)
    assert.ok(toolNames().includes('governance_report'))
  })

  await check('首次加载创建 AGI_STATE.md 骨架（启动协议第一步读它）', async () => {
    const bench = join(workspace, 'AGI_STATE.md')
    await waitFor('workbench skeleton', () => existsSync(bench))
    const text = await readFile(bench, 'utf8')
    assert.match(text, /当前工作台/)
    assert.match(text, /## 下一步/)
    assert.match(text, /## 验证记录/)
  })

  await check('已有工作台不被覆盖；createBench:false 与 read-only 都不创建', async () => {
    const keepRoot = await mkdtemp(join(tmpdir(), 'pseudo-agi-bench-keep-'))
    const own = '# 我自己写的工作台\n\n关键结论。\n'
    await writeFile(join(keepRoot, 'AGI_STATE.md'), own, 'utf8')
    const offRoot = await mkdtemp(join(tmpdir(), 'pseudo-agi-bench-off-'))
    const roRoot = await mkdtemp(join(tmpdir(), 'pseudo-agi-bench-ro-'))
    const extraForks = []
    try {
      for (const [root, extra, policy] of [
        [keepRoot, {}, undefined],
        [offRoot, { createBench: false }, undefined],
        [roRoot, {}, 'read-only'],
      ]) {
        const sub = new Context()
        extraForks.push(sub.plugin(SystemPrompt, { includeHarnessIdentity: true }))
        await waitFor('systemPrompt service', () => sub.get('systemPrompt') !== undefined)
        extraForks.push(sub.plugin(ToolsService, {}))
        await waitFor('tools service', () => sub.get('tools') !== undefined)
        if (policy !== undefined) {
          extraForks.push(sub.plugin({
            name: 'fake-policy',
            apply(ctx) { ctx.provide('sandboxPolicy', { resolve: () => ({ mode: policy }) }) },
          }))
        }
        extraForks.push(sub.plugin(memory, resolveConfig(memory.Config, { workspaceRoot: root, ...extra })))
      }
      // The seeding write is fire-and-forget; wait past it, then assert.
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      assert.equal(await readFile(join(keepRoot, 'AGI_STATE.md'), 'utf8'), own)
      assert.equal(existsSync(join(offRoot, 'AGI_STATE.md')), false)
      assert.equal(existsSync(join(roRoot, 'AGI_STATE.md')), false)
    } finally {
      for (const fork of extraForks.reverse()) await fork.dispose().catch(() => {})
      for (const root of [keepRoot, offRoot, roRoot]) await rm(root, { recursive: true, force: true })
    }
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
    assert.equal(app.tools.checkGuards({ name: 'kb_store', arguments: { action: 'status' } }), undefined)
    assert.equal(app.tools.checkGuards({ name: 'kb_store', arguments: { action: 'relocate', to: '../elsewhere' } }), undefined)
  })

  await check('kb_store 缺 action 或未知 action 被否决', () => {
    assert.match(String(app.tools.checkGuards({ name: 'kb_store', arguments: {} })?.reason), /action/)
    assert.match(String(app.tools.checkGuards({ name: 'kb_store', arguments: { action: 'teleport' } })?.reason), /不认识 action/)
    assert.match(String(app.tools.checkGuards({ name: 'kb_store', arguments: { action: 'relocate' } })?.reason), /to/)
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

  await check('跨工作区：kb_search 命中 workspace 之外的绝对根', async () => {
    const value = await run('kb_search', { query: '跨工作区标记词' })
    assert.equal(value.found, true)
    const hit = value.hits.find(entry => entry.path.includes('external.md'))
    assert.ok(hit, `expected external.md in hits, got ${JSON.stringify(value.hits)}`)
    assert.equal(hit.line, 3)
    // cite() renders paths relative to the workspace, so a cross-root hit is
    // reported as ../<other>/file rather than silently absolute.
    assert.ok(hit.path.startsWith('..'), `cross-root hit should be workspace-relative: ${hit.path}`)
  })

  await check('跨工作区：kb_read 读外部根，controlled_write 写外部根', async () => {
    const read = await run('kb_read', { path: join(externalRoot, 'external.md') })
    assert.match(String(read.content), /跨工作区标记词/)
    const written = await run('controlled_write', {
      path: join(externalRoot, 'written-by-tools.md'),
      content: '外部根写入\n',
    })
    assert.equal(written.created, true)
    assert.equal(await readFile(join(externalRoot, 'written-by-tools.md'), 'utf8'), '外部根写入\n')
  })

  await check('手脚自动跟随会话项目：kb_search 命中会话 docs（无需配置）', async () => {
    const value = await run('kb_search', { query: '会话项目标记词' })
    assert.equal(value.found, true)
    assert.ok(value.hits.some(hit => hit.path.includes('session.md')),
      `expected the session project docs, got ${JSON.stringify(value.hits)}`)
  })

  await check('手脚自动跟随会话项目：controlled_write 写会话项目', async () => {
    const written = await run('controlled_write', {
      path: join(projectRoot, 'written-in-session.md'),
      content: '会话内写入\n',
    })
    assert.equal(written.created, true)
    assert.equal(await readFile(join(projectRoot, 'written-in-session.md'), 'utf8'), '会话内写入\n')
  })

  await check('规则 A：相对路径仍落在记忆/工作台的家，不随会话漂移', async () => {
    await run('controlled_write', { path: 'AGI_STATE.md', content: '# 覆盖测试\n' })
    assert.equal(await readFile(join(workspace, 'AGI_STATE.md'), 'utf8'), '# 覆盖测试\n')
    assert.equal(existsSync(join(projectRoot, 'AGI_STATE.md')), false,
      'a relative path must not drift into the session project')
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

  console.log('\n[3b] 知识库换位置（kb_store）')

  // A minimal knowledge base at the configured default, so relocation has
  // something real to copy: one record and one journal file.
  const storeDir = join(workspace, '.pseudo-agi')
  await mkdir(join(storeDir, 'memory', 'semantic'), { recursive: true })
  await writeFile(join(storeDir, 'memory', 'semantic', 'mem-test.md'), '---\nid: "mem-test"\n---\n# 测试\n', 'utf8')
  await mkdir(join(storeDir, 'governance'), { recursive: true })
  await writeFile(join(storeDir, 'governance', 'session-x.jsonl'), '{"kind":"step"}\n', 'utf8')
  const movedParentDir = await mkdtemp(join(tmpdir(), 'pseudo-agi-moved-'))
  movedParent = movedParentDir
  const movedTo = join(movedParentDir, 'kb')

  await check('status 报告配置默认位置与内容', async () => {
    const value = await run('kb_store', { action: 'status' })
    assert.equal(value.base, storeDir)
    assert.equal(value.source, 'config')
    assert.equal(value.files, 2)
    assert.equal(value.layers.semantic, 1)
    assert.equal(value.governanceFiles, 1)
    assert.equal(value.restartRequired, false)
  })

  await check('relocate 复制、校验、再写指针，源默认保留', async () => {
    const value = await run('kb_store', { action: 'relocate', to: movedTo })
    assert.equal(value.copiedFiles, 2)
    assert.equal(value.copiedBytes, value.bytes)
    assert.equal(value.verified, true)
    assert.equal(value.moved, false)
    assert.equal(value.source, 'pointer')
    assert.equal(value.base, movedTo)
    assert.equal(value.restartRequired, true)
    // Copy, not move: the old tree is still readable, so a rollback loses nothing.
    assert.match(await readFile(join(storeDir, 'memory', 'semantic', 'mem-test.md'), 'utf8'), /mem-test/)
    const pointer = JSON.parse(await readFile(join(storeDir, 'store.json'), 'utf8'))
    assert.equal(pointer.root, movedTo)
    assert.equal(pointer.movedFrom, storeDir)
  })

  await check('迁移后 status 从指针读新位置', async () => {
    const value = await run('kb_store', { action: 'status' })
    assert.equal(value.source, 'pointer')
    assert.equal(value.base, movedTo)
    assert.equal(value.files, 2)
  })

  await check('rollback 只改指针、不动数据', async () => {
    const value = await run('kb_store', { action: 'rollback' })
    assert.equal(value.restartRequired, true)
    assert.equal(value.removedPointer, true)
    assert.equal(value.base, storeDir)
    const after = await run('kb_store', { action: 'status' })
    assert.equal(after.source, 'config')
    assert.equal(after.files, 2)
  })

  await check('重复回滚是幂等的', async () => {
    const value = await run('kb_store', { action: 'rollback' })
    assert.equal(value.restartRequired, false)
    assert.match(value.note, /没有指针/)
  })

  await check('目标非空且未 overwrite 时拒绝，且指针不变', async () => {
    const busy = await mkdtemp(join(tmpdir(), 'pseudo-agi-busy-'))
    await writeFile(join(busy, 'keep.txt'), 'x', 'utf8')
    await assert.rejects(run('kb_store', { action: 'relocate', to: busy }), /非空/)
    assert.equal((await run('kb_store', { action: 'status' })).source, 'config')
    await rm(busy, { recursive: true, force: true })
  })

  await check('搬到当前库内部被拒绝（防递归复制）', async () => {
    await assert.rejects(run('kb_store', { action: 'relocate', to: join(storeDir, 'memory', 'inner') }), /递归复制/)
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

  await check('脚手架把纪律追加进本轮首步，且不做路由', async () => {
    const decision = await app.waterfall(
      {},
      'agent/pre-step',
      { agent, messages, turn: 1, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }),
    )
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[1].source.kind, 'pseudo-agi-scaffold')
    const text = decision.messages[1].content[0].text
    assert.match(text, /本轮纪律/)
    assert.match(text, /不是用户提出的新需求/)
    assert.ok(!text.includes('路由='), 'scaffold must never route')
  })

  await check('记忆注入块真的进入 system prompt 装配结果', async () => {
    const assembly = await app.systemPrompt.assemble({ agent, scope: agent })
    const context = assembly.contexts.find(entry => entry.name === 'pseudo-agi:memory')
    assert.ok(context, 'pseudo-agi:memory context must be assembled for this agent')
    assert.match(context.text, /当前长期记忆/)
    assert.match(context.text, /写操作要先审批/)
    assert.ok(!context.text.includes('{{'), 'memory text must not be interpolated')
  })

  await check('injectPerTurn=1：同一轮只在首步注入', async () => {
    const once = { kind: 'enter', messages }
    const first = await app.waterfall({}, 'agent/pre-step',
      { agent, messages: once.messages, turn: 2, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => once)
    assert.equal(first.messages.length, 2)
    const second = await app.waterfall({}, 'agent/pre-step',
      { agent, messages: once.messages, turn: 2, step: 2, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => once)
    assert.equal(second.messages.length, 1, 'second step in the same turn must not inject again')
  })

  console.log('\n[6] 卸载回收（真实 fiber 所有权）')

  await check('卸载 memory 后：工具、prompt context 同时消失，脚手架仍工作', async () => {
    const memoryFork = forks[0]
    await memoryFork.dispose()
    await waitFor('memory tools gone', () => !toolNames().some(name => name.startsWith('memory_')))
    const assembly = await app.systemPrompt.assemble({ agent, scope: agent })
    assert.equal(assembly.contexts.find(entry => entry.name === 'pseudo-agi:memory'), undefined)
    const decision = await app.waterfall({}, 'agent/pre-step',
      { agent, messages, turn: 3, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }))
    assert.equal(decision.messages.length, 2, 'scaffold is a separate layer and keeps injecting')
    assert.match(decision.messages[1].content[0].text, /本轮纪律/)
  })

  await check('卸载 tools 后 guard 撤销，脚手架与工具解耦', async () => {
    await forks[1].dispose()
    await waitFor('hand tools gone', () => !toolNames().includes('controlled_write'))
    assert.equal(app.tools.checkGuards({ name: 'controlled_write', arguments: { path: '../x' } }), undefined)
    const decision = await app.waterfall({}, 'agent/pre-step',
      { agent, messages, turn: 4, step: 1, signal, modelSelection: { provider: 'p', model: 'm' } },
      async () => ({ kind: 'enter', messages }))
    assert.equal(decision.messages.length, 2, 'scaffold has no tool dependency')
  })

  await check('卸载 scaffold/governance 后只剩空注册表', async () => {
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
  await rm(externalRoot, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
  if (movedParent !== null) await rm(movedParent, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
