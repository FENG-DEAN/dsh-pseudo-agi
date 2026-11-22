/**
 * Runtime smoke test for the parts that do not need a live DSH host.
 *
 * It imports the compiled `lib/` output (not the sources), so a passing run
 * proves the build artifacts are loadable ESM and that the four pieces of pure
 * logic actually behave: Markdown round-trip, layered recall, candidate →
 * commit, prompt budget, routing, path fencing, metrics, JSONL journal.
 *
 * Run with: node scripts/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryStore,
  MEMORY_LAYERS,
  parseRecordFile,
  serializeRecord,
  tokenize,
} from '../packages/pseudo-agi-memory/lib/store.js'
import { fitWithinBudget, estimateTokens } from '../packages/pseudo-agi-memory/lib/budget.js'
import { Config as ScaffoldConfig, disciplineText, validateConfig as validateScaffoldConfig } from '../packages/pseudo-agi-scaffold/lib/config.js'
import { denyReason, isWritable, isWithin, resolveInside } from '../packages/pseudo-agi-tools/lib/workspace.js'
import { createWriteGuard } from '../packages/pseudo-agi-tools/lib/policy.js'
import { JsonlJournal, MetricsBook } from '../packages/pseudo-agi-governance/lib/metrics.js'

let checks = 0
const failures = []

/**
 * @param {string} name
 * @param {() => void | Promise<void>} body
 */
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

const workspace = await mkdtemp(join(tmpdir(), 'pseudo-agi-smoke-'))
const iso = new Date('2026-02-04T02:11:00.000Z').toISOString()

/** @type {import('../packages/pseudo-agi-tools/lib/config.js').ToolsConfig} */
const toolsConfig = {
  workspaceRoot: workspace,
  knowledgeRoots: ['docs'],
  writeRoots: ['.'],
  maxScanBytes: 1024 * 1024,
  maxSnippetChars: 200,
  maxWriteBytes: 4096,
  maxDepth: 4,
  writeRequiresApproval: true,
  deniedSegments: ['.git', 'node_modules', '.ssh', '.env'],
  deniedExtensions: ['.exe', '.ps1'],
}

try {
  console.log('\n[1] 记忆文件格式（Markdown + JSON front matter）')

  const sample = {
    id: 'mem-20260204-aaaa1111',
    layer: 'semantic',
    title: '部署用 pnpm',
    body: '只有 pnpm 能正确处理 workspace 顺序。',
    evidence: [{ kind: 'file', ref: 'docs/install.md' }],
    confidence: 0.9,
    tags: ['build'],
    createdAt: iso,
    updatedAt: iso,
  }

  await check('serialize → parse 无损往返', () => {
    const parsed = parseRecordFile(serializeRecord(sample), 'C:/ws/mem.md')
    assert.equal(parsed.error, undefined)
    assert.deepEqual(
      { ...parsed.record, path: undefined },
      { ...sample, path: undefined },
    )
  })

  await check('无证据的记录被解析器拒绝', () => {
    const broken = parseRecordFile(serializeRecord({ ...sample, evidence: [] }), 'C:/ws/bad.md')
    assert.equal(broken.record, undefined)
    assert.match(broken.error ?? '', /evidence/)
  })

  await check('正文里的 {{ }} 不影响解析', () => {
    const parsed = parseRecordFile(
      serializeRecord({ ...sample, body: '模板片段 {{name}} 要保留字面量。' }),
      'C:/ws/tpl.md',
    )
    assert.equal(parsed.record?.body, '模板片段 {{name}} 要保留字面量。')
  })

  await check('缺 front matter 报错而不是静默通过', () => {
    assert.match(parseRecordFile('just text', 'C:/ws/x.md').error ?? '', /front matter/)
  })

  console.log('\n[2] 分层召回')

  const store = new MemoryStore(join(workspace, '.pseudo-agi', 'memory'))
  const recallOptions = { limit: 6, minScore: 1, minCoverage: 0.34 }

  await check('写入后能被召回，且带来源', async () => {
    await store.writeRecord({
      layer: 'semantic',
      title: '部署用 pnpm',
      body: '只有 pnpm 能正确处理 workspace 顺序。',
      evidence: [{ kind: 'file', ref: 'docs/install.md' }],
      confidence: 0.9,
      tags: ['build'],
    })
    const result = await store.recall('pnpm', recallOptions)
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].record.evidence[0].ref, 'docs/install.md')
    assert.ok(result.hits[0].score > 0)
  })

  await check('中文查询可命中并给出摘要', async () => {
    await store.writeRecord({
      layer: 'procedural',
      title: '写操作要先审批',
      body: '写文件必须经过审批；审批只覆盖一次调用，guard 仍可否决。',
      evidence: [{ kind: 'file', ref: 'docs/spec-compliance.md' }],
      confidence: 0.8,
      tags: ['审批'],
    })
    const result = await store.recall('审批', recallOptions)
    assert.ok(result.hits.length >= 1)
    assert.match(result.hits[0].excerpt, /审批/)
  })

  await check('没有证据时不假装命中', async () => {
    const result = await store.recall('zebraxyz-nonexistent', recallOptions)
    assert.equal(result.hits.length, 0)
    assert.ok(result.considered >= 2)
  })

  await check('按层过滤生效', async () => {
    const onlySemantic = await store.recall('审批', { ...recallOptions }, ['semantic'])
    assert.equal(onlySemantic.hits.length, 0)
  })

  console.log('\n[3] 候选 → 提交')

  await check('候选不进入召回视野', async () => {
    const candidate = await store.writeCandidate({
      layer: 'episodic',
      title: '待确认的结论',
      body: '这条还没批准。',
      evidence: [{ kind: 'user', ref: '用户口述' }],
      confidence: 0.4,
      tags: [],
    })
    const recalled = await store.recall('待确认的结论', recallOptions)
    assert.equal(recalled.hits.length, 0)
    const pending = await store.scanCandidates()
    assert.ok(pending.records.some(record => record.id === candidate.id))
  })

  await check('提交后进入层目录，候选文件消失', async () => {
    const candidate = await store.writeCandidate({
      layer: 'episodic',
      title: 'pnpm 安装曾失败一次',
      body: '因为 registry 超时，重试后成功。',
      evidence: [{ kind: 'tool', ref: 'call_123' }],
      confidence: 0.7,
      tags: ['build'],
    })
    const committed = await store.commitCandidate(candidate.id)
    assert.equal(committed.layer, 'episodic')
    const info = await stat(committed.path)
    assert.ok(info.isFile())
    const recalled = await store.recall('registry 超时', recallOptions)
    assert.ok(recalled.hits.some(hit => hit.record.id === committed.id))
    await assert.rejects(stat(candidate.path))
  })

  await check('无证据的候选被拒绝', async () => {
    await assert.rejects(
      store.writeCandidate({ layer: 'working', title: 'x', body: 'y', evidence: [], confidence: 0.5, tags: [] }),
      /evidence/,
    )
  })

  console.log('\n[4] 注入预算')

  await check('超预算时整条丢弃而不是截断半句', () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `e${index}`,
      title: `记录 ${index}`,
      layer: 'semantic',
      updatedAt: new Date(Date.UTC(2026, 1, 1 + index)).toISOString(),
      confidence: 0.9,
      text: 'x'.repeat(300),
    }))
    const fitted = fitWithinBudget(entries, 200)
    assert.ok(fitted.included > 0 && fitted.included < entries.length)
    assert.equal(fitted.dropped, entries.length - fitted.included)
    assert.ok(fitted.tokens <= 200)
    assert.ok(!fitted.text.endsWith('x…'))
  })

  await check('新的记录优先进入预算', () => {
    const fitted = fitWithinBudget([
      { id: 'old', title: 'old', layer: 'semantic', updatedAt: '2020-01-01T00:00:00.000Z', confidence: 1, text: 'a'.repeat(200) },
      { id: 'new', title: 'new', layer: 'semantic', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 1, text: 'b'.repeat(200) },
    ], 120)
    assert.equal(fitted.included, 1)
    assert.match(fitted.text, /new/)
  })

  await check('token 估算保守（CJK 不低估）', () => {
    assert.equal(estimateTokens(''), 0)
    assert.ok(estimateTokens('中文'.repeat(30)) >= 30)
  })

  console.log('\n[5] 脚手架纪律（纯函数，无路由）')

  await check('默认纪律覆盖取证、来源、写前说明', () => {
    const config = ScaffoldConfig['~standard'].validate({}).value
    const text = disciplineText(config)
    assert.match(text, /本轮纪律/)
    assert.match(text, /带来源/)
    assert.match(text, /没找到/)
    assert.match(text, /一次只改一件事/)
    assert.match(text, /不是用户提出的新需求/)
    assert.match(text, /未经验证/)
  })

  await check('纪律不包含任何路由判断', () => {
    const config = ScaffoldConfig['~standard'].validate({}).value
    const text = disciplineText(config)
    assert.ok(!text.includes('路由='), 'scaffold must not classify the step')
    assert.ok(!/先调用|再调用/.test(text), 'scaffold must not order tool calls')
  })

  await check('关掉 requireEvidence 后不再追加未验证条款', () => {
    const config = ScaffoldConfig['~standard'].validate({ requireEvidence: false }).value
    assert.ok(!disciplineText(config).includes('未经验证'))
  })

  await check('非法 injectPerTurn 在加载期失败', () => {
    const config = ScaffoldConfig['~standard'].validate({}).value
    assert.throws(() => validateScaffoldConfig({ ...config, injectPerTurn: -1 }), /non-negative integer/)
  })

  console.log('\n[6] 路径围栏（guard 用的同步判定）')

  await check('容器判定与越界拒绝', () => {
    assert.equal(isWithin(workspace, join(workspace, 'a', 'b.md')), true)
    assert.equal(isWithin(workspace, join(workspace, '..', 'outside.md')), false)
    assert.throws(() => resolveInside(workspace, '../outside.md'), /路径越界/)
    assert.equal(resolveInside(workspace, 'docs/a.md'), join(workspace, 'docs', 'a.md'))
  })

  await check('禁止段与禁止扩展名', () => {
    assert.match(denyReason(toolsConfig, workspace, join(workspace, '.git', 'config')) ?? '', /被禁止的片段/)
    assert.match(denyReason(toolsConfig, workspace, join(workspace, 'run.ps1')) ?? '', /禁止写入扩展名/)
    assert.equal(denyReason(toolsConfig, workspace, join(workspace, 'docs', 'ok.md')), undefined)
  })

  await check('写根目录限制', () => {
    assert.equal(isWritable(toolsConfig, workspace, join(workspace, 'docs', 'ok.md')), true)
    assert.equal(
      isWritable({ ...toolsConfig, writeRoots: ['docs'] }, workspace, join(workspace, 'src', 'x.md')),
      false,
    )
  })

  console.log('\n[6b] 写入遵守统一文件策略（ctx.sandboxPolicy）')

  const writeCall = path => ({ name: 'controlled_write', arguments: { path }, agent: undefined })

  await check('read-only 策略下 controlled_write 被拒绝', () => {
    const guard = createWriteGuard(toolsConfig, workspace, () => 'read-only')
    assert.match(guard(writeCall('docs/ok.md')) ?? '', /read-only/)
  })

  await check('workspace-write 与 danger-full-access 下正常写入放行', () => {
    for (const mode of ['workspace-write', 'danger-full-access']) {
      const guard = createWriteGuard(toolsConfig, workspace, () => mode)
      assert.equal(guard(writeCall('docs/ok.md')), undefined, mode)
    }
  })

  await check('read-only 不改变越界判定：围栏仍然生效', () => {
    const guard = createWriteGuard(toolsConfig, workspace, () => 'danger-full-access')
    assert.match(guard(writeCall('../escape.md')) ?? '', /路径越界/)
  })

  await check('无策略服务时保持原行为', () => {
    const guard = createWriteGuard(toolsConfig, workspace)
    assert.equal(guard(writeCall('docs/ok.md')), undefined)
  })

  await check('策略只作用于本插件拥有的写工具', () => {
    const guard = createWriteGuard(toolsConfig, workspace, () => 'read-only')
    assert.equal(guard({ name: 'kb_read', arguments: { path: 'docs/ok.md' }, agent: undefined }), undefined)
  })

  console.log('\n[7] 治理指标与审计日志')

  await check('指标累加与容量淘汰', () => {
    const book = new MetricsBook(2)
    const first = book.of('s1')
    first.turns = 2
    first.toolCalls = 4
    first.toolFailures = 1
    first.memoryRecalls = 2
    first.memoryHits = 1
    first.scaffoldSteps = 3
    first.scaffoldInjections = 2
    book.of('s2')
    book.of('s3')
    const snapshot = book.snapshot(10)
    assert.equal(snapshot.length, 2)
    assert.ok(!snapshot.some(metrics => metrics.sessionId === 's1'))
    assert.ok(snapshot.every(metrics => typeof metrics.scaffoldSteps === 'number'))
  })

  await check('JSONL 写入有序、可读回、尾部截断', async () => {
    const journal = new JsonlJournal(join(workspace, 'journal'), message => {
      throw new Error(`journal reported: ${message}`)
    })
    for (let index = 0; index < 5; index++) {
      journal.write({ at: iso, sessionId: 'sess-1', kind: 'tool', detail: { index } })
    }
    await journal.flush()
    const tail = await journal.tail('sess-1', 3)
    assert.equal(tail.length, 3)
    assert.deepEqual(tail.map(record => record.detail.index), [2, 3, 4])
    assert.deepEqual(await journal.tail('missing', 5), [])
  })

  await check('会话 id 被清洗成安全文件名', async () => {
    const journal = new JsonlJournal(join(workspace, 'journal'), () => {})
    journal.write({ at: iso, sessionId: '../../escape', kind: 'turn', detail: {} })
    await journal.flush()
    const entries = await import('node:fs/promises').then(fs => fs.readdir(join(workspace, 'journal')))
    assert.ok(entries.every(name => !name.includes('..')))
    assert.ok(entries.every(name => !name.includes('/') && !name.includes('\\')))
  })

  console.log('\n[8] 层常量')
  await check('四层顺序稳定', () => {
    assert.deepEqual([...MEMORY_LAYERS], ['working', 'episodic', 'semantic', 'procedural'])
    assert.deepEqual(tokenize('Deploy 部署'), ['deploy', '部', '署', '部署'])
  })

  console.log('\n[9] 记忆取代（supersedes）')

  const replaceStore = new MemoryStore(join(workspace, '.pseudo-agi', 'memory-supersede'))
  let retiredId

  await check('新记录取代旧记录：旧记录默认不再出现', async () => {
    const older = await replaceStore.writeRecord({
      layer: 'semantic',
      title: '面板路由无凭据即返回 200',
      body: '面板接口无凭据即返回 200，未决是否为契约。',
      evidence: [{ kind: 'file', ref: 'docs/architecture.md' }],
      confidence: 0.8,
      tags: ['panel'],
    })
    retiredId = older.id
    const newer = await replaceStore.writeRecord({
      layer: 'semantic',
      title: '面板路由校验签名 cookie',
      body: '面板接口校验 dsh-auth 签名 cookie，无 cookie 返回 401。',
      evidence: [{ kind: 'file', ref: 'docs/architecture.md' }],
      confidence: 0.95,
      tags: ['panel'],
      supersedes: [older.id],
    })
    const visible = await replaceStore.scan()
    assert.deepEqual(visible.records.map(record => record.id), [newer.id])
  })

  await check('旧记录仍在磁盘上，且带 supersededBy', async () => {
    const all = await replaceStore.scan(MEMORY_LAYERS, { includeSuperseded: true })
    const retired = all.records.find(record => record.id === retiredId)
    assert.ok(retired !== undefined, 'superseded record must survive on disk')
    assert.equal(typeof retired.supersededBy, 'string')
  })

  await check('被取代的记录不会被召回', async () => {
    const result = await replaceStore.recall('无凭据 200', { limit: 5, minScore: 1, minCoverage: 0.2 })
    assert.ok(result.hits.every(hit => hit.record.id !== retiredId))
  })

  await check('候选携带的 supersedes 能往返序列化', () => {
    const text = serializeRecord({
      id: 'cand-test',
      layer: 'semantic',
      title: 't',
      body: 'b',
      evidence: [{ kind: 'file', ref: 'docs/architecture.md' }],
      confidence: 0.7,
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      supersedes: ['mem-old'],
    })
    assert.match(text, /supersedes: \["mem-old"\]/)
    const parsed = parseRecordFile(text, '/tmp/x.md')
    assert.deepEqual(parsed.record.supersedes, ['mem-old'])
  })

  await check('supersedes 指向不存在的 id 时不报错', async () => {
    const record = await replaceStore.writeRecord({
      layer: 'semantic',
      title: '替换一条已不存在的记录',
      body: 'x',
      evidence: [{ kind: 'file', ref: 'docs/architecture.md' }],
      confidence: 0.7,
      tags: [],
      supersedes: ['mem-does-not-exist'],
    })
    assert.equal(record.supersedes.length, 1)
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
