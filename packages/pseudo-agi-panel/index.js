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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
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
 * The Host Connection's browser-session credential. Its secret signs the
 * `dsh-auth-<hash>` cookie that `dsh web` mints after the launch-token
 * handshake, and the key's runtime form is the joined `<scope>/<id>` string, so
 * verifying a browser request needs no import from the owning package.
 *
 * Why the panel verifies it itself: a plugin prefix route is served by nothing
 * that checks this cookie — only the Host Connection's own index and API
 * carriers authenticate — so without this check any local caller could read the
 * whole state file.
 */
const AUTH_RECORD_KEY = 'client-connection/browser-session'
const AUTH_COOKIE_PREFIX = 'dsh-auth-'
const AUTH_SECRET_BYTES = 32
const AUTH_COOKIE_BASE64URL = /^[A-Za-z0-9_-]*$/

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
 * Encode bytes the way the Host Connection encodes cookie names and values.
 * @param {Buffer} value bytes to encode.
 * @returns {string} unpadded base64url.
 */
function base64Url(value) {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Decode canonical unpadded base64url.
 * @param {string} text encoded value.
 * @returns {Buffer|undefined} the bytes, or undefined when not canonical.
 */
function unbase64Url(text) {
  if (typeof text !== 'string' || text.length % 4 === 1 || !AUTH_COOKIE_BASE64URL.test(text)) return undefined
  const padding = '='.repeat((4 - (text.length % 4)) % 4)
  const bytes = Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return base64Url(bytes) === text ? bytes : undefined
}

/**
 * Read one named cookie without implementing general Cookie decoding.
 * @param {string} header raw `cookie` header value.
 * @param {string} name exact cookie name.
 * @returns {string|undefined} the value, or undefined when absent.
 */
function cookieValue(header, name) {
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Load the secret that signs this Harness home's browser-session cookie.
 * @param {object} ctx plugin context.
 * @returns {Promise<Buffer|undefined>} the secret, or undefined when no host
 *   mints cookies here (no credentials service, no record, unknown format).
 */
async function browserSessionSecret(ctx) {
  const credentials = ctx.get('credentials', false)
  if (credentials === undefined || typeof credentials.readRecord !== 'function') return undefined
  let record
  try {
    record = await credentials.readRecord(AUTH_RECORD_KEY)
  } catch {
    return undefined
  }
  if (record === undefined || record.kind !== 'grant' || record.payload?.version !== 1) return undefined
  const secret = unbase64Url(record.payload.secret)
  return secret !== undefined && secret.byteLength === AUTH_SECRET_BYTES ? secret : undefined
}

/**
 * Verify one browser-session cookie against the Harness secret.
 * @param {string} value raw cookie value: `v<version>.<payload>.<signature>`.
 * @param {Buffer} secret signing secret bytes.
 * @param {string} authority the request `host`, which binds cookie to origin.
 * @returns {boolean} true only for an unexpired cookie signed by this Harness.
 */
function cookieAuthentic(value, secret, authority) {
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [version, body, encoded] = parts
  if (version !== 'v1' && version !== 'v2') return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const actual = unbase64Url(encoded)
  if (actual === undefined || actual.byteLength !== expected.byteLength
    || !timingSafeEqual(actual, expected)) return false
  const payloadBytes = unbase64Url(body)
  if (payloadBytes === undefined) return false
  let payload
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return false
  }
  if (payload === null || typeof payload !== 'object' || payload.authority !== authority) return false
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) return false
  const now = Date.now()
  return payload.issuedAt <= now && payload.expiresAt > now
}

/**
 * Decide whether one request may read panel state.
 * @param {object} req incoming request.
 * @param {Buffer|undefined} secret signing secret, absent when this host mints no cookies.
 * @returns {'allowed'|'denied'|'unverifiable'} the verdict.
 */
function authorize(req, secret) {
  if (secret === undefined) return 'unverifiable'
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority.length === 0) return 'denied'
  const header = req.headers.cookie
  if (typeof header !== 'string') return 'denied'
  const name = AUTH_COOKIE_PREFIX + base64Url(createHash('sha256').update(authority).digest())
  const value = cookieValue(header, name)
  return value !== undefined && cookieAuthentic(value, secret, authority) ? 'allowed' : 'denied'
}

/**
 * Mount the panel's read-only route.
 * @param {object} ctx plugin context.
 * @param {object} config plugin config with `workspaceRoot`.
 */
export function apply(ctx, config) {
  validateConfig(config)
  const root = resolve(config.workspaceRoot)
  // Resolved once per activation: the cookie secret is durable for this Harness home.
  const secretReady = browserSessionSecret(ctx).catch((error) => {
    ctx.logger.warn(`pseudo-agi-panel: browser-session secret unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  let warnedUnverifiable = false

  /**
   * Answer one panel request. Every request must carry the Harness
   * browser-session cookie; only GET /state exists; everything else 404s.
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
      const verdict = authorize(req, await secretReady)
      if (verdict === 'denied') {
        send(401, { ok: false, error: 'authentication required' })
        return
      }
      if (verdict === 'unverifiable' && !warnedUnverifiable) {
        warnedUnverifiable = true
        ctx.logger.warn('pseudo-agi-panel: this host mints no browser-session cookie; serving state without authentication')
      }
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
