/**
 * Profile-level preflight: can the DSH loader actually resolve and configure
 * the two layers we just linked into the desktop profile?
 *
 * This runs from the profile's own resolution root (`node_modules`), validates
 * the exact config blocks written into `cordis.patch.yml` against each plugin's
 * Schemastery schema, and parses the patch file itself when a YAML parser is
 * reachable. A green run means "restart and it should load"; it cannot prove
 * the host's loader wiring, which only a real start can.
 *
 * Run with: node scripts/profile-check.mjs
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const profile = 'C:/Users/FDA/.dsh/profiles/desktop'
const require = createRequire(`${profile}/package.json`)

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

const expected = {
  '@pseudo-agi/memory': {
    root: '.pseudo-agi/memory',
    maxInjectTokens: 900,
    verifyFileEvidence: true,
    writeWorkingDigest: true,
    workspaceRoot: 'D:/Doc/AIDoc/Dsh_dev/dsh_agi_dev',
  },
  '@pseudo-agi/tools': {
    writeRequiresApproval: true,
    workspaceRoot: 'D:/Doc/AIDoc/Dsh_dev/dsh_agi_dev',
    knowledgeRoots: ['docs', '.pseudo-agi/memory'],
    writeRoots: ['.'],
  },
  '@pseudo-agi/scaffold': {
    enabled: true,
    injectPerTurn: 1,
    requireEvidence: true,
  },
  '@pseudo-agi/governance': {
    workspaceRoot: 'D:/Doc/AIDoc/Dsh_dev/dsh_agi_dev',
    root: '.pseudo-agi/governance',
    journal: true,
    maxSessions: 64,
    maxRecentLines: 40,
  },
}

console.log('\n[1] 从 profile 的解析根加载包')

for (const [name, config] of Object.entries(expected)) {
  await check(`${name} 可被 profile 解析并 import`, async () => {
    const resolved = require.resolve(name)
    console.log(`       → ${resolved}`)
    if (!resolved.startsWith('D:\\Doc\\AIDoc\\Dsh_dev\\dsh_agi_dev')) {
      throw new Error(`解析到了非预期位置：${resolved}`)
    }
    const module = await import(pathToFileURL(resolved).href)
    if (typeof module.name !== 'string') throw new Error('missing name')
    if (!Array.isArray(module.inject)) throw new Error('missing inject')
    if (typeof module.apply !== 'function') throw new Error('missing apply')
    if (typeof module.Config?.['~standard']?.validate !== 'function') throw new Error('missing Config schema')
    if (module.name !== name.split('/')[1].replace('pseudo-agi-', 'pseudo-agi-') && !module.name.startsWith('pseudo-agi-')) {
      throw new Error(`unexpected plugin name ${module.name}`)
    }
  })
}

await check('@pseudo-agi/panel 可被 profile 解析，且 client 侧含侧栏注册', async () => {
  const resolved = require.resolve('@pseudo-agi/panel')
  console.log(`       → ${resolved}`)
  if (!resolved.startsWith('D:\\Doc\\AIDoc\\Dsh_dev\\dsh_agi_dev')) {
    throw new Error(`解析到了非预期位置：${resolved}`)
  }
  const module = await import(pathToFileURL(resolved).href)
  if (module.name !== 'pseudo-agi-panel') throw new Error(`unexpected name ${module.name}`)
  if (!Array.isArray(module.inject)) throw new Error('missing inject')
  if (typeof module.apply !== 'function') throw new Error('missing apply')
  const client = await readFile(new URL('./client.js', pathToFileURL(resolved)), 'utf8')
  for (const marker of ['__ModuleLoader__', "'sidebar.panellist'", "'main'", '/pseudo-agi/api']) {
    if (!client.includes(marker)) throw new Error(`client.js missing ${marker}`)
  }
  console.log(`       → client.js ${client.length} 字节，含 sidebar.panellist + main 注册`)
})

console.log('\n[2] patch 里的 config 能通过各自的 Schemastery 校验')
for (const [name, config] of Object.entries(expected)) {
  await check(`${name} 接受 cordis.patch.yml 中的配置`, async () => {
    const module = await import(pathToFileURL(require.resolve(name)).href)
    const result = module.Config['~standard'].validate(config)
    if (result.issues) throw new Error(JSON.stringify(result.issues))
    const value = result.value
    if (value.workspaceRoot !== config.workspaceRoot) {
      throw new Error(`workspaceRoot not applied: ${value.workspaceRoot}`)
    }
    for (const key of Object.keys(config)) {
      if (!(key in value)) throw new Error(`resolved config lost "${key}"`)
    }
  })
}

console.log('\n[3] patch 文件本身')

await check('cordis.patch.yml 含 pseudo-agi 的 insert 行', async () => {
  const text = await readFile(`${profile}/cordis.patch.yml`, 'utf8')
  if (!text.includes('- insert:')) throw new Error('missing "- insert:" block')
  for (const name of Object.keys(expected)) {
    if (!text.includes(`"${name}"`)) throw new Error(`missing "${name}" row`)
  }
  console.log(`       → ${text.split('\n').filter(line => line.includes('pseudo-agi')).length} 行涉及 pseudo-agi`)
})

await check('package.json 声明了两个 link 依赖', async () => {
  const manifest = JSON.parse(await readFile(`${profile}/package.json`, 'utf8'))
  for (const name of Object.keys(expected)) {
    const specifier = manifest.dependencies?.[name]
    if (typeof specifier !== 'string' || !specifier.startsWith('link:')) {
      throw new Error(`${name} dependency is not a link: ${String(specifier)}`)
    }
  }
})

let yamlLoaded = false
await check('YAML 结构解析通过（insert 列表结构正确）', async () => {
  const localRequire = createRequire(new URL('../package.json', import.meta.url))
  const yaml = await import(pathToFileURL(localRequire.resolve('js-yaml')).href)
  const load = yaml.load ?? yaml.parse ?? yaml.default?.load
  if (typeof load !== 'function') throw new Error('js-yaml exposes no load()')
  yamlLoaded = true
  const document = load(await readFile(`${profile}/cordis.patch.yml`, 'utf8'))
  if (!Array.isArray(document)) throw new Error('patch root must be an array')
  const insert = document.find(entry => entry && Array.isArray(entry.insert))
  if (!insert) throw new Error('no insert entry')
  const ids = insert.insert.map(row => row.id)
  for (const id of ['pseudo-agi-memory', 'pseudo-agi-tools']) {
    if (!ids.includes(id)) throw new Error(`insert list missing id ${id}`)
  }
  const memory = insert.insert.find(row => row.id === 'pseudo-agi-memory')
  if (memory?.config?.workspaceRoot !== 'D:/Doc/AIDoc/Dsh_dev/dsh_agi_dev') {
    throw new Error(`parsed workspaceRoot mismatch: ${JSON.stringify(memory?.config)}`)
  }
  const tools = insert.insert.find(row => row.id === 'pseudo-agi-tools')
  if (!Array.isArray(tools?.config?.knowledgeRoots)) {
    throw new Error('parsed knowledgeRoots is not a list')
  }
})

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} passed, ${failures.length} failed${yamlLoaded ? '' : '（YAML 结构解析已跳过）'}`)
if (failures.length > 0) process.exitCode = 1
