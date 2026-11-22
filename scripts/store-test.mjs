/**
 * Store-location test: the resolver, the pointer precedence, the move/rollback
 * primitive, and the one thing the layers must agree on — that their shipped
 * default paths all map onto the same live root.
 *
 * This is where "换位置" is pinned. The layers themselves are covered by
 * `load-test.mjs` (tools) and `panel-test.mjs` (the panel); what can break
 * silently there is the *agreement* between them, and that is a pure function.
 *
 * Run with: node scripts/store-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  defaultWorkspaceRoot,
  isWithin,
  pointerPath,
  relocateStore,
  resolveStore,
  resolveWorkspaceRoot,
  rollbackStore,
  storePath,
  storeStats,
} from '../packages/pseudo-agi-store/index.js'
import { Config as MemoryConfig } from '../packages/pseudo-agi-memory/lib/config.js'
import { Config as GovernanceConfig } from '../packages/pseudo-agi-governance/lib/config.js'
import { Config as ToolsConfig } from '../packages/pseudo-agi-tools/lib/config.js'

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

function resolveConfig(schema, input) {
  const result = schema['~standard'].validate(input)
  if (result.issues) throw new Error(`invalid config: ${JSON.stringify(result.issues)}`)
  return result.value
}

/** Whether a path exists, without caring what it is. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const workspace = await mkdtemp(join(tmpdir(), 'pseudo-agi-store-'))
const movedParent = await mkdtemp(join(tmpdir(), 'pseudo-agi-store-moved-'))
const movedTo = join(movedParent, 'kb')

/** Seed a small knowledge base at `base`. */
async function seed(base) {
  await mkdir(join(base, 'memory', 'semantic'), { recursive: true })
  await mkdir(join(base, 'memory', 'procedural'), { recursive: true })
  await mkdir(join(base, 'memory', 'candidates'), { recursive: true })
  await mkdir(join(base, 'governance'), { recursive: true })
  await writeFile(join(base, 'memory', 'semantic', 'mem-a.md'), '---\nid: "mem-a"\n---\n# A\n', 'utf8')
  await writeFile(join(base, 'memory', 'procedural', 'mem-b.md'), '---\nid: "mem-b"\n---\n# B\n', 'utf8')
  await writeFile(join(base, 'memory', 'candidates', 'cand-a.json'), '{"id":"cand-a"}\n', 'utf8')
  await writeFile(join(base, 'governance', 'session-1.jsonl'), '{"kind":"step"}\n', 'utf8')
  await writeFile(join(base, 'working.md'), '# 工作记忆摘要\n', 'utf8')
}

try {
  console.log('\n[1] 解析优先级：指针 → 配置 → 默认')

  await check('未配置 workspaceRoot 时落到用户主目录下的固定目录', () => {
    const base = defaultWorkspaceRoot()
    assert.ok(base.startsWith(homedir()), `default must live under the home directory: ${base}`)
    assert.equal(base, join(homedir(), 'dsh-pseudo-agi'))
    // Empty and whitespace both mean "default"; an explicit value is honoured,
    // including `.` for a deployment that really wants the process cwd.
    assert.equal(resolveWorkspaceRoot(''), base)
    assert.equal(resolveWorkspaceRoot('   '), base)
    assert.equal(resolveWorkspaceRoot(undefined), base)
    assert.equal(resolveWorkspaceRoot(workspace), resolve(workspace))
    assert.equal(resolveWorkspaceRoot('.'), resolve('.'))
  })

  await check('三个 Schemastery 层的 workspaceRoot 默认值都是空（= 平台默认）', () => {
    for (const [name, schema] of [['memory', MemoryConfig], ['governance', GovernanceConfig], ['tools', ToolsConfig]]) {
      const value = resolveConfig(schema, {})
      assert.equal(value.workspaceRoot, '', `${name} must default to the platform default`)
    }
  })

  await check('没有指针时用配置默认值', () => {
    const location = resolveStore({ workspaceRoot: workspace })
    assert.equal(location.source, 'config')
    assert.equal(location.base, join(workspace, '.pseudo-agi'))
    assert.equal(location.fallback, join(workspace, '.pseudo-agi'))
    assert.equal(location.pointer, null)
    assert.equal(location.warning, undefined)
  })

  await check('配置的 storeRoot 可以是绝对路径', () => {
    const location = resolveStore({ workspaceRoot: workspace, storeRoot: movedParent })
    assert.equal(location.source, 'config')
    assert.equal(location.base, movedParent)
  })

  await check('指针存在时压过配置', async () => {
    await mkdir(join(workspace, '.pseudo-agi'), { recursive: true })
    await writeFile(pointerPath(workspace), JSON.stringify({ version: 1, root: movedTo, movedFrom: 'x' }), 'utf8')
    const location = resolveStore({ workspaceRoot: workspace, storeRoot: 'ignored-by-pointer' })
    assert.equal(location.source, 'pointer')
    assert.equal(location.base, movedTo)
    assert.equal(location.pointer.movedFrom, 'x')
  })

  await check('指针里的相对路径按 workspaceRoot 解析', async () => {
    await writeFile(pointerPath(workspace), JSON.stringify({ version: 1, root: 'relative-kb' }), 'utf8')
    const location = resolveStore({ workspaceRoot: workspace })
    assert.equal(location.base, join(workspace, 'relative-kb'))
  })

  await check('指针损坏时回退配置并给出 warning，不抛错', async () => {
    await writeFile(pointerPath(workspace), '{ not json', 'utf8')
    const location = resolveStore({ workspaceRoot: workspace })
    assert.equal(location.source, 'config')
    assert.match(location.warning ?? '', /not valid JSON/)
    await writeFile(pointerPath(workspace), JSON.stringify({ version: 1 }), 'utf8')
    assert.match(resolveStore({ workspaceRoot: workspace }).warning ?? '', /root/)
    await rm(pointerPath(workspace), { force: true })
  })

  await check('缺 workspaceRoot 直接抛错（禁止用 cwd 兜底）', () => {
    assert.throws(() => resolveStore({}), /workspaceRoot/)
    assert.throws(() => resolveStore({ workspaceRoot: '  ' }), /workspaceRoot/)
  })

  console.log('\n[2] 配置路径 → 活动根')

  const location = resolveStore({ workspaceRoot: workspace })

  await check('.pseudo-agi 前缀的路径跟随活动根', () => {
    assert.equal(storePath(location, '.pseudo-agi/memory'), join(workspace, '.pseudo-agi', 'memory'))
    assert.equal(storePath(location, '.pseudo-agi'), join(workspace, '.pseudo-agi'))
    assert.equal(storePath(location, '.pseudo-agi\\governance'), join(workspace, '.pseudo-agi', 'governance'))
  })

  await check('普通相对路径仍按 workspaceRoot 解析', () => {
    assert.equal(storePath(location, 'docs'), join(workspace, 'docs'))
    assert.equal(storePath(location, ''), workspace)
  })

  await check('绝对路径原样保留（显式位置不受指针影响）', () => {
    assert.equal(storePath(location, movedParent), movedParent)
  })

  console.log('\n[3] 统计与迁移')

  const base = join(workspace, '.pseudo-agi')
  await seed(base)

  await check('storeStats 数清各子树', async () => {
    const stats = await storeStats(location)
    assert.equal(stats.exists, true)
    assert.equal(stats.layers.semantic, 1)
    assert.equal(stats.layers.procedural, 1)
    assert.equal(stats.layers.working, 0)
    assert.equal(stats.candidates, 1)
    assert.equal(stats.governanceFiles, 1)
    assert.equal(stats.workingDigest, true)
    // 2 records + 1 candidate + 1 journal + working.md
    assert.equal(stats.files, 5)
    assert.ok(stats.bytes > 0)
  })

  await check('当前位置不存在时统计为 0', async () => {
    const empty = await storeStats(resolveStore({ workspaceRoot: workspace, storeRoot: 'nowhere' }))
    assert.equal(empty.exists, false)
    assert.equal(empty.files, 0)
  })

  await check('relocate 复制、校验、最后写指针', async () => {
    const report = await relocateStore(location, { to: movedTo })
    assert.equal(report.from, base)
    assert.equal(report.to, movedTo)
    assert.equal(report.copied.files, 5)
    assert.equal(report.verified, true)
    assert.equal(report.moved, false)
    assert.equal(report.restartRequired, true)
    // 源保留：搬家不是删除操作
    assert.equal(await exists(join(base, 'memory', 'semantic', 'mem-a.md')), true)
    const pointer = JSON.parse(await readFile(pointerPath(workspace), 'utf8'))
    assert.equal(pointer.version, 1)
    assert.equal(pointer.root, movedTo)
    assert.equal(pointer.movedFrom, base)
    assert.equal(pointer.copiedFiles, 5)
    // 指针本身不复制进新树
    assert.equal(await exists(join(movedTo, 'store.json')), false)
  })

  await check('迁移后解析到新位置，且内容一致', async () => {
    const moved = resolveStore({ workspaceRoot: workspace })
    assert.equal(moved.source, 'pointer')
    assert.equal(moved.base, movedTo)
    const stats = await storeStats(moved)
    assert.equal(stats.files, 5)
    assert.equal(await readFile(join(movedTo, 'memory', 'procedural', 'mem-b.md'), 'utf8'), '---\nid: "mem-b"\n---\n# B\n')
  })

  await check('目标非空且未 overwrite 时拒绝，指针不变', async () => {
    const busy = await mkdtemp(join(tmpdir(), 'pseudo-agi-store-busy-'))
    await writeFile(join(busy, 'keep.txt'), 'x', 'utf8')
    await assert.rejects(relocateStore(resolveStore({ workspaceRoot: workspace }), { to: busy }), /非空/)
    assert.equal(resolveStore({ workspaceRoot: workspace }).base, movedTo)
    await rm(busy, { recursive: true, force: true })
  })

  await check('目标在源内部 / 源在目标内部 / 目标即源 都被拒绝', async () => {
    await assert.rejects(relocateStore(location, { to: join(base, 'memory', 'inner') }), /递归复制/)
    await assert.rejects(relocateStore(location, { to: workspace }), /包含当前知识库/)
    await assert.rejects(relocateStore(location, { to: base }), /相同/)
  })

  await check('rollback 删指针（默认位置）', async () => {
    const report = await rollbackStore(resolveStore({ workspaceRoot: workspace }))
    assert.equal(report.changed, true)
    assert.equal(report.removed, true)
    assert.equal(report.base, base)
    assert.equal(await exists(pointerPath(workspace)), false)
    assert.equal(resolveStore({ workspaceRoot: workspace }).source, 'config')
  })

  await check('无指针时 rollback 是幂等的', async () => {
    const report = await rollbackStore(resolveStore({ workspaceRoot: workspace }))
    assert.equal(report.changed, false)
    assert.match(report.reason ?? '', /没有指针/)
  })

  await check('rollback 能回到指针记录的上一个位置', async () => {
    await writeFile(pointerPath(workspace), JSON.stringify({ version: 1, root: movedTo, movedFrom: movedParent }), 'utf8')
    const report = await rollbackStore(resolveStore({ workspaceRoot: workspace }))
    assert.equal(report.removed, false)
    assert.equal(report.base, movedParent)
    const pointer = JSON.parse(await readFile(pointerPath(workspace), 'utf8'))
    assert.equal(pointer.root, movedParent)
    assert.equal(pointer.movedFrom, movedTo)
    await rm(pointerPath(workspace), { force: true })
  })

  await check('move: true 删源内容但保留指针文件', async () => {
    const moveTo = join(movedParent, 'moved-kb')
    const report = await relocateStore(resolveStore({ workspaceRoot: workspace }), { to: moveTo, move: true })
    assert.equal(report.moved, true)
    assert.equal(await exists(join(base, 'memory')), false)
    assert.equal(await exists(join(base, 'governance')), false)
    assert.equal(await exists(pointerPath(workspace)), true)
    assert.equal(await exists(join(moveTo, 'memory', 'semantic', 'mem-a.md')), true)
  })

  console.log('\n[4] 四层默认路径落到同一个活动根')

  await rm(pointerPath(workspace), { force: true })
  const memory = resolveConfig(MemoryConfig, { workspaceRoot: workspace })
  const governance = resolveConfig(GovernanceConfig, { workspaceRoot: workspace })
  const tools = resolveConfig(ToolsConfig, { workspaceRoot: workspace })

  await check('三层的 storeRoot 默认值一致', () => {
    assert.equal(memory.storeRoot, '.pseudo-agi')
    assert.equal(governance.storeRoot, '.pseudo-agi')
    assert.equal(tools.storeRoot, '.pseudo-agi')
  })

  await check('默认配置下三层指向同一棵树', () => {
    const at = resolveStore({ workspaceRoot: workspace, storeRoot: memory.storeRoot })
    assert.equal(storePath(at, memory.root), join(workspace, '.pseudo-agi', 'memory'))
    assert.equal(storePath(at, governance.root), join(workspace, '.pseudo-agi', 'governance'))
    assert.deepEqual(tools.knowledgeRoots.map(root => storePath(at, root)), [
      join(workspace, 'docs'),
      join(workspace, '.pseudo-agi', 'memory'),
    ])
  })

  await check('指针一改，三层同时跟到新根（这就是"换位置"的全部机制）', async () => {
    const elsewhere = join(movedParent, 'elsewhere')
    await writeFile(pointerPath(workspace), JSON.stringify({ version: 1, root: elsewhere }), 'utf8')
    const at = resolveStore({ workspaceRoot: workspace, storeRoot: memory.storeRoot })
    assert.equal(at.source, 'pointer')
    assert.equal(storePath(at, memory.root), join(elsewhere, 'memory'))
    assert.equal(storePath(at, governance.root), join(elsewhere, 'governance'))
    assert.equal(storePath(at, tools.knowledgeRoots[1]), join(elsewhere, 'memory'))
    await rm(pointerPath(workspace), { force: true })
  })

  await check('isWithin 对同目录与子目录成立、对兄弟不成立', () => {
    assert.equal(isWithin(base, join(base, 'memory')), true)
    assert.equal(isWithin(base, base), true)
    assert.equal(isWithin(base, join(workspace, 'docs')), false)
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(movedParent, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
