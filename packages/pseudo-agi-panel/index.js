/**
 * Host half of the Whale-girl AGI panel.
 *
 * It owns exactly one same-origin JSON route and nothing else: the panel is a
 * read-only viewer over files the other layers already write, so it can be
 * unloaded at any time without the AGI losing a capability. No state is kept
 * between requests; every read reflects the filesystem right now.
 *
 * @module @pseudo-agi/panel
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Plugin name. */
export const name = 'pseudo-agi-panel'

/** Only the web server: this plugin never touches tools, memory, or the loop. */
export const inject = ['webServer']

/** Same-origin JSON route prefix owned by this plugin. */
const ROUTE_PREFIX = '/pseudo-agi/api'

/** Memory layers, in the order the panel lists them. */
const LAYERS = ['working', 'episodic', 'semantic', 'procedural']

/** Hard caps so one huge file cannot stall the panel. */
const MAX_TEXT = 4000
const MAX_EVENTS = 20
const MAX_MEMORIES = 40

/**
 * Assert the config the panel depends on.
 * @param {object} config resolved plugin config.
 */
function validateConfig(config) {
  const workspaceRoot = config?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new Error('pseudo-agi-panel: config.workspaceRoot must be a non-empty string')
  }
}

/**
 * Read one file, tolerating absence.
 * @param {string} path absolute path.
 * @param {number} limit maximum characters returned.
 * @returns {Promise<string|null>} the text, or null when unreadable.
 */
async function readText(path, limit) {
  try {
    const text = await readFile(path, 'utf8')
    return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`
  } catch {
    return null
  }
}

/**
 * Parse the few front-matter fields the panel shows. The memory layer owns the
 * format; this reader deliberately stays shallow and never rewrites anything.
 * @param {string} text record file contents.
 * @param {string} path absolute path, used only for a fallback id.
 * @returns {object|null} a view model, or null when the file is not a record.
 */
function parseRecord(text, path) {
  const end = text.indexOf('\n---', 4)
  if (!text.startsWith('---\n') || end < 0) return null
  const header = text.slice(4, end)
  const field = key => {
    const match = new RegExp(`^${key}: (.*)$`, 'm').exec(header)
    if (match === null) return undefined
    try {
      return JSON.parse(match[1])
    } catch {
      return match[1]
    }
  }
  const id = field('id')
  const layer = field('layer')
  if (typeof id !== 'string' || typeof layer !== 'string') return null
  return {
    id,
    layer,
    title: typeof field('title') === 'string' ? field('title') : '(untitled)',
    confidence: typeof field('confidence') === 'number' ? field('confidence') : null,
    updatedAt: typeof field('updatedAt') === 'string' ? field('updatedAt') : null,
    path,
  }
}

/**
 * Collect every memory record, newest first.
 * @param {string} root workspace root.
 * @returns {Promise<{memories: object[], counts: Record<string, number>, errors: string[]}>} the view.
 */
async function collectMemories(root) {
  const memories = []
  const counts = {}
  const errors = []
  for (const layer of LAYERS) {
    let names
    try {
      names = await readdir(join(root, '.pseudo-agi', 'memory', layer))
    } catch {
      counts[layer] = 0
      continue
    }
    let count = 0
    for (const candidate of names.sort()) {
      if (!candidate.endsWith('.md')) continue
      const path = join(root, '.pseudo-agi', 'memory', layer, candidate)
      const text = await readText(path, 64 * 1024)
      if (text === null) {
        errors.push(`${layer}/${candidate}: unreadable`)
        continue
      }
      const record = parseRecord(text, path)
      if (record === null) {
        errors.push(`${layer}/${candidate}: not a memory record`)
        continue
      }
      memories.push(record)
      count++
    }
    counts[layer] = count
  }
  memories.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
  return { memories: memories.slice(0, MAX_MEMORIES), counts, errors }
}

/**
 * Read the tail of the newest governance journal, if any.
 * @param {string} root workspace root.
 * @returns {Promise<object[]>} journal records, oldest first.
 */
async function collectEvents(root) {
  const directory = join(root, '.pseudo-agi', 'governance')
  let names
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const candidates = []
  for (const candidate of names) {
    if (!candidate.endsWith('.jsonl')) continue
    try {
      candidates.push({ name: candidate, info: await stat(join(directory, candidate)) })
    } catch {
      // A file that vanishes between readdir and stat is simply not listed.
    }
  }
  if (candidates.length === 0) return []
  candidates.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)
  const text = await readText(join(directory, candidates[0].name), 256 * 1024)
  if (text === null) return []
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const records = []
  for (const line of lines.slice(-MAX_EVENTS)) {
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn trailing line after a crash is expected; skip it.
    }
  }
  return records
}

/**
 * Build one snapshot for the panel.
 * @param {object} ctx plugin context.
 * @param {string} root workspace root.
 * @returns {Promise<object>} the payload.
 */
async function collect(ctx, root) {
  const [{ memories, counts, errors }, events, bench, state] = await Promise.all([
    collectMemories(root),
    collectEvents(root),
    readText(join(root, '.pseudo-agi', 'working.md'), MAX_TEXT),
    readText(join(root, 'AGI_STATE.md'), MAX_TEXT),
  ])
  // Optional read: the tool registry may not be mounted in a minimal deploy.
  let toolCount = null
  try {
    const tools = ctx.get('tools', false)
    if (tools !== undefined && typeof tools.definitions === 'function') {
      toolCount = tools.definitions().length
    }
  } catch {
    toolCount = null
  }
  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot: root,
    layers: counts,
    memoryTotal: Object.values(counts).reduce((sum, value) => sum + value, 0),
    memories,
    events,
    toolCount,
    workingDigest: bench,
    agiState: state,
    errors,
  }
}

/**
 * Mount the panel's read-only route.
 * @param {object} ctx plugin context.
 * @param {object} config plugin config with `workspaceRoot`.
 */
export function apply(ctx, config) {
  validateConfig(config)
  const root = resolve(config.workspaceRoot)

  /**
   * Answer one panel request. Only GET /state exists; everything else 404s.
   * @param {import('node:http').IncomingMessage} req incoming request.
   * @param {import('node:http').ServerResponse} res response to own.
   */
  const handle = async (req, res) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    }
    try {
      if (req.method !== 'GET') {
        send(405, { ok: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
      if (action !== 'state') {
        send(404, { ok: false, error: `unknown action "${action}"` })
        return
      }
      send(200, { ok: true, data: await collect(ctx, root) })
    } catch (error) {
      ctx.logger.warn(`pseudo-agi-panel: ${error instanceof Error ? error.message : String(error)}`)
      send(500, { ok: false, error: 'internal error' })
    }
  }

  const off = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => { void handle(req, res) },
  })
  ctx.effect(() => () => off(), 'pseudo-agi-panel:route')
}
