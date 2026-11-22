/**
 * Where the pseudo-AGI knowledge base lives, and how to move it.
 *
 * The knowledge base is a directory tree (memory records, staged candidates,
 * the working digest, the governance journal), not a database. It defaults to
 * `<workspaceRoot>/.pseudo-agi`, but a deployment may prefer another disk, a
 * synced folder, or a second profile that must not share the same tree.
 *
 * That choice is stored as **data**, not only as configuration: the pointer
 * file `<workspaceRoot>/.pseudo-agi/store.json` names the live root. Every layer
 * follows that one file, so moving the knowledge base is one edit instead of
 * four config rows (`memory.root`, `tools.knowledgeRoots`, `governance.root`,
 * `panel.storeRoot`) that are free to drift apart. Drift is exactly the defect
 * this project already shipped twice with `workspaceRoot`.
 *
 * The pointer lives at a fixed workspace path on purpose: a pointer stored
 * inside the tree it points at would move with the tree and lose the old
 * address.
 *
 * This is a plain library, not a cordis plugin — it has no build step, like the
 * panel, and no dependency on the harness. The four layers import it.
 *
 * @module @pseudo-agi/store
 */

import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Name of the store directory when it lives inside the workspace. */
export const STORE_DIR = '.pseudo-agi'

/** File name of the pointer that records the live root. */
export const STORE_POINTER = 'store.json'

/** Pointer format version. Bump only on an incompatible change. */
export const STORE_VERSION = 1

/** Layers the knowledge base owns, in the order a reader lists them. */
export const STORE_LAYERS = ['working', 'episodic', 'semantic', 'procedural']

/** Directory created under the user's home when no workspace root is configured. */
export const DEFAULT_WORKSPACE_DIR = 'dsh-pseudo-agi'

/**
 * Where the pseudo-AGI keeps its workspace when a deployment configures nothing.
 *
 * A plugin may not fall back to `process.cwd()`: the host process usually runs
 * from its install directory, which differs per machine and may not be writable.
 * The user's home is stable, writable, and the same place the rest of a user's
 * data lives — so an install with no configuration still lands somewhere sane.
 * @returns {string} absolute default workspace root.
 */
export function defaultWorkspaceRoot() {
  return join(homedir(), DEFAULT_WORKSPACE_DIR)
}

/**
 * Resolve the workspace root a layer should use.
 *
 * An empty setting means "use the default"; an explicit value (including `.`)
 * is resolved as given, so a deployment that wants the current directory can
 * still ask for it.
 * @param {string|undefined} configured the `workspaceRoot` setting.
 * @returns {string} absolute workspace root.
 */
export function resolveWorkspaceRoot(configured) {
  const text = typeof configured === 'string' ? configured.trim() : ''
  return text === '' ? defaultWorkspaceRoot() : resolve(text)
}

/** Whether two paths are compared case-insensitively on this platform. */
const CASELESS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Normalize a path for containment comparison.
 * @param {string} path any path.
 * @returns {string} the absolute, case-folded path.
 */
function comparable(path) {
  const normalized = resolve(path)
  return CASELESS ? normalized.toLowerCase() : normalized
}

/**
 * Whether `target` is `root` itself or lies inside it.
 * @param {string} root containing directory.
 * @param {string} target candidate path.
 * @returns {boolean} true when contained.
 */
export function isWithin(root, target) {
  const rel = relative(comparable(root), comparable(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Absolute path of the pointer file for one workspace.
 * @param {string} workspaceRoot absolute or relative workspace root.
 * @returns {string} absolute pointer path.
 */
export function pointerPath(workspaceRoot) {
  return join(resolve(workspaceRoot), STORE_DIR, STORE_POINTER)
}

/**
 * Read the pointer without throwing. A broken pointer must degrade to the
 * configured default plus a warning, never fail a plugin load: an unreadable
 * JSON is not a reason to lose access to the memory tree.
 * @param {string} workspaceRoot absolute workspace root.
 * @returns {{path: string, record: object|null, warning: string|undefined}} the read result.
 */
function readPointer(workspaceRoot) {
  const path = pointerPath(workspaceRoot)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = error?.code
    return { path, record: null, warning: code === 'ENOENT' ? undefined : `pointer unreadable (${String(code ?? 'unknown')})` }
  }
  let record
  try {
    record = JSON.parse(text)
  } catch (error) {
    return { path, record: null, warning: `pointer is not valid JSON: ${String(error?.message ?? error)}` }
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { path, record: null, warning: 'pointer is not a JSON object' }
  }
  if (typeof record.root !== 'string' || record.root.trim() === '') {
    return { path, record: null, warning: 'pointer has no non-empty "root" string' }
  }
  return { path, record, warning: undefined }
}

/**
 * Resolve the live store root for one deployment.
 *
 * Priority: the pointer file wins, then the configured `storeRoot`, then
 * `<workspaceRoot>/.pseudo-agi`. A configured root is what a fresh deployment
 * declares; the pointer is what a move rewrites. Keeping the pointer on top
 * lets a relocation take effect everywhere without editing four configs.
 *
 * @param {{workspaceRoot: string, storeRoot?: string}} options workspace root and configured default.
 * @returns {{
 *   workspaceRoot: string, base: string, source: 'pointer'|'config',
 *   pointerPath: string, pointer: object|null, fallback: string, warning: string|undefined,
 * }} the resolved location.
 * @throws when `workspaceRoot` is missing: resolving against a process cwd is
 *   the defect this project already recorded twice.
 */
export function resolveStore({ workspaceRoot, storeRoot = STORE_DIR } = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('@pseudo-agi/store: resolveStore requires a non-empty workspaceRoot')
  }
  const root = resolve(workspaceRoot)
  const pointer = readPointer(root)
  const fallback = isAbsolute(storeRoot) ? resolve(storeRoot) : resolve(root, storeRoot)
  if (pointer.record !== null) {
    return {
      workspaceRoot: root,
      base: isAbsolute(pointer.record.root) ? resolve(pointer.record.root) : resolve(root, pointer.record.root),
      source: 'pointer',
      pointerPath: pointer.path,
      pointer: pointer.record,
      fallback,
      warning: pointer.warning,
    }
  }
  return {
    workspaceRoot: root,
    base: fallback,
    source: 'config',
    pointerPath: pointer.path,
    pointer: null,
    fallback,
    warning: pointer.warning,
  }
}

/**
 * Map one configured path onto the live store.
 *
 * A path that starts with the store directory name is treated as *relative to
 * the store* (`.pseudo-agi/memory` → `<base>/memory`), which is what the
 * shipped configs already say, so relocation works without rewriting them.
 * Anything else keeps the old meaning: absolute stays absolute, relative is
 * resolved against the workspace root. That is the escape hatch for a caller
 * that wants a fixed location regardless of the pointer.
 *
 * @param {object} location result of {@link resolveStore}.
 * @param {string} candidate configured path.
 * @returns {string} absolute path.
 */
export function storePath(location, candidate) {
  const text = String(candidate ?? '')
  const slashed = text.replaceAll('\\', '/')
  if (slashed === STORE_DIR) return location.base
  if (slashed.startsWith(`${STORE_DIR}/`)) {
    const tail = slashed.slice(STORE_DIR.length + 1)
    return tail === '' ? location.base : join(location.base, tail)
  }
  return isAbsolute(text) ? resolve(text) : resolve(location.workspaceRoot, text)
}

/**
 * Walk a directory tree, tolerating absence.
 * @param {string} directory absolute directory.
 * @param {(path: string) => Promise<void>} onFile called for every regular file.
 * @returns {Promise<void>} resolves when the walk ends.
 */
async function walk(directory, onFile) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, onFile)
    else if (entry.isFile()) await onFile(path)
  }
}

/**
 * Count what a store root holds. Used both by `kb_store status` and as the
 * pre-flight check of a relocation, so "how much would move" and "how much
 * moved" are measured the same way.
 * @param {object} location result of {@link resolveStore}.
 * @returns {Promise<object>} counts and byte totals.
 */
export async function storeStats(location) {
  const base = location.base
  const layers = {}
  for (const layer of STORE_LAYERS) layers[layer] = 0
  let candidates = 0
  let governanceFiles = 0
  let workingDigest = false
  let files = 0
  let bytes = 0

  /** @param {string} path file path. @returns {Promise<number>} its size, or 0. */
  const sizeOf = async (path) => {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  }

  for (const layer of STORE_LAYERS) {
    await walk(join(base, 'memory', layer), async (path) => {
      if (!path.endsWith('.md')) return
      layers[layer]++
      files++
      bytes += await sizeOf(path)
    })
  }
  await walk(join(base, 'memory', 'candidates'), async (path) => {
    candidates++
    files++
    bytes += await sizeOf(path)
  })
  await walk(join(base, 'governance'), async (path) => {
    governanceFiles++
    files++
    bytes += await sizeOf(path)
  })
  try {
    workingDigest = (await stat(join(base, 'working.md'))).isFile()
  } catch {
    workingDigest = false
  }
  if (workingDigest) {
    files++
    bytes += await sizeOf(join(base, 'working.md'))
  }

  let exists = false
  try {
    exists = (await stat(base)).isDirectory()
  } catch {
    exists = false
  }

  return { base, exists, files, bytes, layers, candidates, governanceFiles, workingDigest }
}

/**
 * Copy a tree, skipping one path. Bytes are copied verbatim (no newline or
 * encoding rewrite), so a byte-for-byte comparison after the copy is meaningful.
 * @param {string} from source directory.
 * @param {string} to destination directory.
 * @param {(path: string) => boolean} skip predicate on the source path.
 * @returns {Promise<{files: number, bytes: number}>} what was copied.
 */
async function copyTree(from, to, skip) {
  const total = { files: 0, bytes: 0 }
  /** @param {string} source @param {string} target @returns {Promise<void>} */
  const step = async (source, target) => {
    let entries
    try {
      entries = await readdir(source, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    await mkdir(target, { recursive: true })
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      if (skip(sourcePath)) continue
      const targetPath = join(target, entry.name)
      if (entry.isDirectory()) {
        await step(sourcePath, targetPath)
      } else if (entry.isFile()) {
        const payload = await readFile(sourcePath)
        await writeFile(targetPath, payload)
        total.files++
        total.bytes += payload.byteLength
      }
    }
  }
  await step(from, to)
  return total
}

/**
 * Write the pointer that makes `root` the live store.
 * @param {string} workspaceRoot absolute workspace root.
 * @param {object} record pointer record.
 * @returns {Promise<string>} the pointer path written.
 */
async function writePointer(workspaceRoot, record) {
  const path = pointerPath(workspaceRoot)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ version: STORE_VERSION, ...record }, null, 2)}\n`, 'utf8')
  return path
}

/**
 * Move the knowledge base to another location.
 *
 * Order matters and is deliberate: copy → verify → write pointer. The pointer is
 * written last, so a failed or partial copy leaves the live store exactly where
 * it was. The source is kept unless `move` is explicitly true, because deleting
 * data is not a side effect a routine relocation should have.
 *
 * @param {object} location result of {@link resolveStore}.
 * @param {{to: string, move?: boolean, overwrite?: boolean}} options destination and safety switches.
 * @returns {Promise<object>} the relocation report.
 * @throws when the destination is invalid, non-empty without `overwrite`, or the copy does not verify.
 */
export async function relocateStore(location, { to, move = false, overwrite = false } = {}) {
  if (typeof to !== 'string' || to.trim() === '') {
    throw new Error('@pseudo-agi/store: relocateStore requires a non-empty "to" path')
  }
  const from = location.base
  const target = isAbsolute(to) ? resolve(to) : resolve(location.workspaceRoot, to)
  if (comparable(from) === comparable(target)) {
    throw new Error(`目标位置与当前位置相同：${target}`)
  }
  if (isWithin(from, target)) {
    throw new Error(`目标位于当前知识库内部，会递归复制：${target}`)
  }
  if (isWithin(target, from)) {
    throw new Error(`目标包含当前知识库，复制结果不可信：${target}`)
  }

  const before = await storeStats(location)
  if (!before.exists) {
    throw new Error(`当前知识库不存在：${from}（先写入一条记忆，或修正 workspaceRoot/storeRoot）`)
  }

  let existing = 0
  try {
    existing = (await readdir(target, { withFileTypes: true })).length
  } catch {
    existing = 0
  }
  if (existing > 0 && !overwrite) {
    throw new Error(`目标目录非空（${existing} 项）：${target}。确认覆盖请显式传 overwrite: true`)
  }

  const skipPointer = (path) => comparable(path) === comparable(location.pointerPath)
  const copied = await copyTree(from, target, skipPointer)
  if (copied.files !== before.files) {
    throw new Error(`复制校验失败：源 ${before.files} 个文件，目标 ${copied.files} 个。指针未改动，仍在 ${from}`)
  }
  if (copied.bytes !== before.bytes) {
    throw new Error(`复制校验失败：源 ${before.bytes} bytes，目标 ${copied.bytes} bytes。指针未改动，仍在 ${from}`)
  }

  const pointer = await writePointer(location.workspaceRoot, {
    root: target,
    movedAt: new Date().toISOString(),
    movedFrom: from,
    copiedFiles: copied.files,
    copiedBytes: copied.bytes,
  })

  if (move === true) {
    for (const name of await readdir(from)) {
      const path = join(from, name)
      if (skipPointer(path)) continue
      await rm(path, { recursive: true, force: true })
    }
  }

  return {
    from,
    to: target,
    copied,
    verified: true,
    moved: move === true,
    pointerPath: pointer,
    restartRequired: true,
  }
}

/**
 * Point the store back at an earlier location (or at the configured default).
 *
 * The data is never touched here: relocation copies by default, so the old tree
 * is still on disk. Rolling back is therefore just re-pointing — which is also
 * why a mistaken move cannot lose records.
 *
 * @param {object} location result of {@link resolveStore}.
 * @param {{to?: string}} options explicit destination; defaults to the recorded `movedFrom`, then the configured default.
 * @returns {Promise<object>} the rollback report.
 */
export async function rollbackStore(location, { to } = {}) {
  if (location.pointer === null) {
    return {
      changed: false,
      removed: false,
      base: location.base,
      from: location.base,
      reason: '没有指针文件：知识库当前就在配置的默认位置',
    }
  }
  const recorded = location.pointer.movedFrom
  const target = typeof to === 'string' && to.trim() !== ''
    ? (isAbsolute(to) ? resolve(to) : resolve(location.workspaceRoot, to))
    : (typeof recorded === 'string' && recorded.trim() !== '' ? resolve(recorded) : location.fallback)

  if (comparable(target) === comparable(location.fallback)) {
    await rm(location.pointerPath, { force: true })
    return { changed: true, removed: true, base: target, from: location.base }
  }
  await writePointer(location.workspaceRoot, {
    root: target,
    movedAt: new Date().toISOString(),
    movedFrom: location.base,
    copiedFiles: 0,
    copiedBytes: 0,
  })
  return { changed: true, removed: false, base: target, from: location.base }
}
