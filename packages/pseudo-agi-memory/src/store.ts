/**
 * Markdown-first layered memory store.
 *
 * The Markdown files are the source of truth: one file per record under
 * `<root>/<layer>/<id>.md`, front matter encoded as JSON values so the format
 * round-trips without a YAML dependency. There is no durable index that can be
 * lost — recall rebuilds term statistics from the files on every scan, and only
 * an in-process, mtime-checked parse cache is kept.
 *
 * @module @pseudo-agi/memory/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The four layers of the memory hierarchy. */
export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'procedural'

/** Every layer, ordered from most volatile to most stable. */
export const MEMORY_LAYERS: readonly MemoryLayer[] = ['working', 'episodic', 'semantic', 'procedural']

/** Where a claim came from. `ref` is a path, URL, tool call id, or session id. */
export interface Evidence {
  readonly kind: 'file' | 'url' | 'tool' | 'session' | 'user'
  readonly ref: string
}

/** One parsed memory record. */
export interface MemoryRecord {
  readonly id: string
  readonly layer: MemoryLayer
  readonly title: string
  readonly body: string
  readonly evidence: readonly Evidence[]
  readonly confidence: number
  readonly tags: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * Id of the record that replaced this one. A superseded record stays on disk
   * (history is worth keeping) but is skipped by recall, injection and digests.
   */
  readonly supersededBy?: string
  /** Ids this record declares it replaces; carried from candidate through commit. */
  readonly supersedes?: readonly string[]
  /** Absolute path of the Markdown file backing this record. */
  readonly path: string
}

/** Input accepted by {@link MemoryStore.writeRecord}. */
export interface WriteRecordInput {
  readonly layer: MemoryLayer
  readonly title: string
  readonly body: string
  readonly evidence: readonly Evidence[]
  readonly confidence: number
  readonly tags: readonly string[]
  readonly id?: string
  readonly createdAt?: string
  /**
   * Records this write replaces. The store marks each one `supersededBy`, so a
   * contradiction is settled by the model's own judgement rather than by an
   * automatic pick. Unknown ids are ignored: replacing something already
   * deleted is not an error.
   */
  readonly supersedes?: readonly string[]
}

/** One recall hit with its scoring detail. */
export interface RecallHit {
  readonly record: MemoryRecord
  readonly score: number
  readonly coverage: number
  readonly excerpt: string
}

/** Complete recall outcome, including the "nothing reliable found" case. */
export interface RecallResult {
  readonly hits: readonly RecallHit[]
  readonly considered: number
  readonly terms: readonly string[]
  /**
   * Pairs among the returned hits that look like they may contradict each
   * other: same tags, overlapping titles, both still live. Reported, never
   * resolved — which of the two is right is a judgement only the reader can make.
   */
  readonly conflicts: readonly RecallConflict[]
}

/** Two recalled records that plausibly say different things about one topic. */
export interface RecallConflict {
  readonly a: string
  readonly b: string
  readonly sharedTags: readonly string[]
}

/** Recall tuning, supplied by the plugin config. */
export interface RecallOptions {
  readonly limit: number
  readonly minScore: number
  readonly minCoverage: number
}

const FRONT_MATTER = '---'

/** Files the store parses; anything else in a layer directory is ignored. */
const RECORD_SUFFIX = '.md'

/** Id prefix of a committed record. */
const RECORD_PREFIX = 'mem-'

/** Id prefix of a staged candidate. */
const CANDIDATE_PREFIX = 'cand-'

/** Latin words plus CJK single characters and bigrams are enough for recall. */
const LATIN_WORD = /[a-z0-9_]{2,}/g
const CJK_RUN = /[\u4e00-\u9fff]+/g

/**
 * Split text into recall terms: lower-cased latin words (2+ chars) and CJK
 * unigrams plus bigrams.
 * @param text - any text.
 * @returns the term list, in occurrence order, with duplicates.
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const terms: string[] = []
  for (const match of lowered.matchAll(LATIN_WORD)) terms.push(match[0])
  for (const match of lowered.matchAll(CJK_RUN)) {
    const run = match[0]
    for (const char of run) terms.push(char)
    for (let index = 0; index + 1 < run.length; index++) terms.push(run.slice(index, index + 2))
  }
  return terms
}

/**
 * Serialize one record as Markdown with JSON-valued front matter.
 * @param record - the record to render.
 * @returns the file contents, terminated by a newline.
 */
export function serializeRecord(record: Omit<MemoryRecord, 'path'>): string {
  const lines = [
    FRONT_MATTER,
    `id: ${JSON.stringify(record.id)}`,
    `layer: ${JSON.stringify(record.layer)}`,
    `title: ${JSON.stringify(record.title)}`,
    `confidence: ${JSON.stringify(record.confidence)}`,
    `tags: ${JSON.stringify(record.tags)}`,
    `evidence: ${JSON.stringify(record.evidence)}`,
    `createdAt: ${JSON.stringify(record.createdAt)}`,
    `updatedAt: ${JSON.stringify(record.updatedAt)}`,
  ]
  if (record.supersededBy !== undefined) lines.push(`supersededBy: ${JSON.stringify(record.supersededBy)}`)
  if (record.supersedes !== undefined && record.supersedes.length > 0) {
    lines.push(`supersedes: ${JSON.stringify(record.supersedes)}`)
  }
  return [
    ...lines,
    FRONT_MATTER,
    '',
    record.body.trimEnd(),
    '',
  ].join('\n')
}

/**
 * Parse one record file. A malformed file yields an error instead of a record,
 * so a hand-edited mistake never silently becomes a memory.
 * @param text - the file contents.
 * @param path - absolute path the contents came from.
 * @returns the record, or the reason it could not be read.
 */
export function parseRecordFile(text: string, path: string): { record?: MemoryRecord; error?: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(`${FRONT_MATTER}\n`)) return { error: 'missing front matter' }
  const end = normalized.indexOf(`\n${FRONT_MATTER}`, FRONT_MATTER.length)
  if (end < 0) return { error: 'unterminated front matter' }
  const header = normalized.slice(FRONT_MATTER.length + 1, end)
  const body = normalized.slice(end + FRONT_MATTER.length + 1).trim()

  const fields = new Map<string, unknown>()
  for (const line of header.split('\n')) {
    if (line.trim().length === 0) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return { error: `malformed front-matter line ${JSON.stringify(line)}` }
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    try {
      fields.set(key, JSON.parse(raw))
    } catch {
      return { error: `front-matter field "${key}" is not JSON` }
    }
  }

  const id = fields.get('id')
  const layer = fields.get('layer')
  const title = fields.get('title')
  const confidence = fields.get('confidence')
  const tags = fields.get('tags')
  const evidence = fields.get('evidence')
  const createdAt = fields.get('createdAt')
  const updatedAt = fields.get('updatedAt')
  const supersededBy = fields.get('supersededBy')
  const supersedes = fields.get('supersedes')

  if (typeof id !== 'string' || id.length === 0) return { error: 'front-matter "id" must be a non-empty string' }
  if (typeof layer !== 'string' || !MEMORY_LAYERS.includes(layer as MemoryLayer)) {
    return { error: `front-matter "layer" must be one of ${MEMORY_LAYERS.join(', ')}` }
  }
  if (typeof title !== 'string') return { error: 'front-matter "title" must be a string' }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { error: 'front-matter "confidence" must be a number between 0 and 1' }
  }
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) {
    return { error: 'front-matter "tags" must be an array of strings' }
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { error: 'front-matter "evidence" must be a non-empty array' }
  }
  const parsedEvidence: Evidence[] = []
  for (const entry of evidence) {
    if (typeof entry !== 'object' || entry === null) return { error: 'each evidence entry must be an object' }
    const kind = (entry as { kind?: unknown }).kind
    const ref = (entry as { ref?: unknown }).ref
    if (typeof kind !== 'string' || typeof ref !== 'string' || ref.length === 0) {
      return { error: 'each evidence entry needs a string "kind" and a non-empty string "ref"' }
    }
    parsedEvidence.push({ kind: kind as Evidence['kind'], ref })
  }
  if (supersededBy !== undefined && (typeof supersededBy !== 'string' || supersededBy.length === 0)) {
    return { error: 'front-matter "supersededBy" must be a non-empty string when present' }
  }
  if (supersedes !== undefined
    && (!Array.isArray(supersedes) || supersedes.some(entry => typeof entry !== 'string'))) {
    return { error: 'front-matter "supersedes" must be an array of strings when present' }
  }

  return {
    record: {
      id,
      layer: layer as MemoryLayer,
      title,
      body,
      evidence: parsedEvidence,
      confidence,
      tags: tags as string[],
      createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
      updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date(0).toISOString(),
      ...typeof supersededBy === 'string' ? { supersededBy } : {},
      ...Array.isArray(supersedes) ? { supersedes: supersedes as string[] } : {},
      path,
    },
  }
}

/** One layer-directory scan outcome. */
export interface ScanResult {
  readonly records: readonly MemoryRecord[]
  /** Malformed files, one entry per failure; never fatal. */
  readonly errors: readonly string[]
}

/**
 * The store itself. All paths are absolute; callers own the root directory.
 */
export class MemoryStore {
  private readonly cache = new Map<string, { mtimeMs: number; record: MemoryRecord }>()

  constructor(readonly root: string) {}

  /** Directory holding one layer. */
  layerDir(layer: MemoryLayer): string {
    return join(this.root, layer)
  }

  /** Directory holding uncommitted candidates. */
  get candidateDir(): string {
    return join(this.root, 'candidates')
  }

  /**
   * Read every record in the requested layers.
   * @param layers - layers to scan; defaults to every layer.
   * @param options - `includeSuperseded` also returns records another record replaced.
   * @returns records and non-fatal parse errors.
   */
  async scan(
    layers: readonly MemoryLayer[] = MEMORY_LAYERS,
    options: { readonly includeSuperseded?: boolean } = {},
  ): Promise<ScanResult> {
    const records: MemoryRecord[] = []
    const errors: string[] = []
    for (const layer of layers) {
      const directory = this.layerDir(layer)
      let names: string[]
      try {
        names = await readdir(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const name of names.sort()) {
        if (!name.endsWith(RECORD_SUFFIX)) continue
        const path = join(directory, name)
        let mtimeMs: number
        try {
          const info = await stat(path)
          if (!info.isFile()) continue
          mtimeMs = info.mtimeMs
        } catch {
          continue
        }
        const cached = this.cache.get(path)
        if (cached !== undefined && cached.mtimeMs === mtimeMs) {
          records.push(cached.record)
          continue
        }
        const text = await readFile(path, 'utf8')
        const parsed = parseRecordFile(text, path)
        if (parsed.record === undefined) {
          errors.push(`${path}: ${parsed.error ?? 'unreadable record'}`)
          this.cache.delete(path)
          continue
        }
        this.cache.set(path, { mtimeMs, record: parsed.record })
        records.push(parsed.record)
      }
    }
    return {
      records: options.includeSuperseded === true
        ? records
        : records.filter(record => record.supersededBy === undefined),
      errors,
    }
  }

  /** Scan the candidate directory with the same parser. */
  async scanCandidates(): Promise<ScanResult> {
    const records: MemoryRecord[] = []
    const errors: string[] = []
    let names: string[]
    try {
      names = await readdir(this.candidateDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, errors }
      throw error
    }
    for (const name of names.sort()) {
      if (!name.endsWith(RECORD_SUFFIX)) continue
      const path = join(this.candidateDir, name)
      const text = await readFile(path, 'utf8')
      const parsed = parseRecordFile(text, path)
      if (parsed.record === undefined) {
        errors.push(`${path}: ${parsed.error ?? 'unreadable candidate'}`)
        continue
      }
      records.push(parsed.record)
    }
    return { records, errors }
  }

  /**
   * Write one record atomically (temp file + rename) into its layer directory.
   * @param input - record fields; `id`/`createdAt` are generated when omitted.
   * @returns the record as written.
   */
  async writeRecord(input: WriteRecordInput): Promise<MemoryRecord> {
    if (input.evidence.length === 0) {
      throw new Error('refusing to persist a memory without evidence: every record needs at least one source')
    }
    const directory = this.layerDir(input.layer)
    await mkdir(directory, { recursive: true })
    const now = new Date().toISOString()
    const id = input.id ?? `mem-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`
    const path = join(directory, `${id}${RECORD_SUFFIX}`)
    const supersedes = input.supersedes?.filter(entry => entry !== id)
    const record: MemoryRecord = {
      id,
      layer: input.layer,
      title: input.title,
      body: input.body,
      evidence: input.evidence,
      confidence: input.confidence,
      tags: input.tags,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      ...supersedes !== undefined && supersedes.length > 0 ? { supersedes } : {},
      path,
    }
    await this.atomicWrite(path, serializeRecord(record))
    this.cache.set(path, { mtimeMs: (await stat(path)).mtimeMs, record })
    if (supersedes !== undefined && supersedes.length > 0) {
      for (const replaced of supersedes) await this.markSuperseded(replaced, id)
    }
    return record
  }

  /**
   * Retire one existing record in place by pointing it at its replacement.
   * The file stays on disk: history is worth keeping, and a wrong supersede is
   * reversible by editing one line.
   * @param id - record to retire.
   * @param byId - the record that replaces it.
   * @returns whether the record was found.
   */
  private async markSuperseded(id: string, byId: string): Promise<boolean> {
    const { records } = await this.scan(MEMORY_LAYERS, { includeSuperseded: true })
    const target = records.find(record => record.id === id)
    if (target === undefined) return false
    const updated: MemoryRecord = { ...target, supersededBy: byId, updatedAt: new Date().toISOString() }
    await this.atomicWrite(target.path, serializeRecord(updated))
    this.cache.delete(target.path)
    return true
  }

  /**
   * Write a candidate that is NOT yet memory. Candidates live outside the
   * layer directories so recall never sees them.
   * @param input - candidate fields; the layer is the intended destination.
   * @returns the candidate record with its file path.
   */
  async writeCandidate(input: WriteRecordInput): Promise<MemoryRecord> {
    if (input.evidence.length === 0) {
      throw new Error('refusing to stage a candidate without evidence: cite what the claim rests on')
    }
    await mkdir(this.candidateDir, { recursive: true })
    const now = new Date().toISOString()
    const id = input.id ?? `cand-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`
    const path = join(this.candidateDir, `${id}${RECORD_SUFFIX}`)
    const supersedes = input.supersedes?.filter(entry => entry !== id)
    const record: MemoryRecord = {
      id,
      layer: input.layer,
      title: input.title,
      body: input.body,
      evidence: input.evidence,
      confidence: input.confidence,
      tags: input.tags,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      ...supersedes !== undefined && supersedes.length > 0 ? { supersedes } : {},
      path,
    }
    await this.atomicWrite(path, serializeRecord(record))
    return record
  }

  /**
   * Promote one candidate into its layer directory, preserving identity and
   * creation time, then remove the candidate file.
   * @param candidateId - the id of a file in the candidate directory.
   * @returns the committed record.
   */
  async commitCandidate(candidateId: string): Promise<MemoryRecord> {
    const path = join(this.candidateDir, `${candidateId}${RECORD_SUFFIX}`)
    const text = await readFile(path, 'utf8')
    const parsed = parseRecordFile(text, path)
    if (parsed.record === undefined) throw new Error(`candidate "${candidateId}" is unreadable: ${parsed.error}`)
    // A promoted record is no longer a candidate: give it the permanent
    // `mem-` identity so the directory itself distinguishes the two states.
    const id = parsed.record.id.startsWith(CANDIDATE_PREFIX)
      ? `${RECORD_PREFIX}${parsed.record.id.slice(CANDIDATE_PREFIX.length)}`
      : parsed.record.id
    const record = await this.writeRecord({
      id,
      layer: parsed.record.layer,
      title: parsed.record.title,
      body: parsed.record.body,
      evidence: parsed.record.evidence,
      confidence: parsed.record.confidence,
      tags: parsed.record.tags,
      createdAt: parsed.record.createdAt,
      // The replacement declared at staging time is applied now, not before:
      // retiring a record on the strength of an uncommitted claim would be wrong.
      ...parsed.record.supersedes !== undefined ? { supersedes: parsed.record.supersedes } : {},
    })
    await rm(path, { force: true })
    return record
  }

  /**
   * Delete one record by id.
   * @param id - record id.
   * @returns the path that was removed.
   */
  async remove(id: string): Promise<string> {
    const scanned = await this.scan()
    const found = scanned.records.find(record => record.id === id)
    if (found === undefined) throw new Error(`no memory record with id "${id}"`)
    await rm(found.path, { force: true })
    this.cache.delete(found.path)
    return found.path
  }

  /**
   * Score every record against one query. A hit needs both an absolute score
   * floor and query-term coverage, so a single common character cannot make a
   * record look relevant.
   * @param query - the recall query.
   * @param options - limit and both floors.
   * @param layers - layers to consider.
   * @returns ranked hits and the terms that were scored.
   */
  async recall(query: string, options: RecallOptions, layers: readonly MemoryLayer[] = MEMORY_LAYERS): Promise<RecallResult> {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return { hits: [], considered: 0, terms: [], conflicts: [] }
    const { records } = await this.scan(layers)
    if (records.length === 0) return { hits: [], considered: 0, terms, conflicts: [] }

    const profiles = records.map(record => ({
      record,
      title: new Set(tokenize(record.title)),
      tags: new Set(tokenize(record.tags.join(' '))),
      body: new Set(tokenize(record.body)),
    }))

    const documentFrequency = new Map<string, number>()
    for (const profile of profiles) {
      const seen = new Set<string>()
      for (const term of terms) {
        if (profile.title.has(term) || profile.tags.has(term) || profile.body.has(term)) seen.add(term)
      }
      for (const term of seen) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }

    const hits: RecallHit[] = []
    for (const profile of profiles) {
      let score = 0
      let matched = 0
      for (const term of terms) {
        const frequency = documentFrequency.get(term) ?? 0
        if (frequency === 0) continue
        const inverse = Math.log(1 + profiles.length / frequency)
        let weight = 0
        if (profile.title.has(term)) weight += 3
        if (profile.tags.has(term)) weight += 2
        if (profile.body.has(term)) weight += 1
        if (weight === 0) continue
        matched++
        score += inverse * weight
      }
      const coverage = matched / terms.length
      if (score < options.minScore || coverage < options.minCoverage) continue
      hits.push({ record: profile.record, score, coverage, excerpt: excerptOf(profile.record.body, terms) })
    }

    hits.sort((left, right) => right.score - left.score
      || right.record.updatedAt.localeCompare(left.record.updatedAt))
    const top = hits.slice(0, options.limit)
    return { hits: top, considered: records.length, terms, conflicts: conflictsOf(top) }
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  }
}

/**
 * Find the recalled pairs that plausibly disagree.
 *
 * The test is deliberately shallow and explainable: two hits sharing at least
 * one tag AND overlapping by two or more title words are reported as a pair
 * worth a second look. It never hides or reorders anything — deciding which of
 * the two is right belongs to the reader, not to the store.
 *
 * @param hits - the records being returned, in ranked order.
 * @returns the suspicious pairs, as ids plus the tags they share.
 */
function conflictsOf(hits: readonly RecallHit[]): RecallConflict[] {
  const wordsOf = (text: string) => new Set(tokenize(text).filter(term => term.length >= 2))
  const conflicts: RecallConflict[] = []
  for (let left = 0; left < hits.length; left++) {
    for (let right = left + 1; right < hits.length; right++) {
      const a = hits[left]?.record
      const b = hits[right]?.record
      if (a === undefined || b === undefined) continue
      const sharedTags = a.tags.filter(tag => b.tags.includes(tag))
      if (sharedTags.length === 0) continue
      const bWords = wordsOf(b.title)
      const overlap = [...wordsOf(a.title)].filter(word => bWords.has(word))
      if (overlap.length < 2) continue
      conflicts.push({ a: a.id, b: b.id, sharedTags })
    }
  }
  return conflicts
}

/** Bound one excerpt around the first term occurrence. */
function excerptOf(body: string, terms: readonly string[], width = 240): string {
  const flattened = body.replace(/\s+/g, ' ').trim()
  if (flattened.length <= width) return flattened
  const lowered = flattened.toLowerCase()
  let first = -1
  for (const term of terms) {
    const index = lowered.indexOf(term)
    if (index >= 0 && (first < 0 || index < first)) first = index
  }
  if (first < 0) return `${flattened.slice(0, width)}…`
  const start = Math.max(0, first - Math.floor(width / 3))
  const end = Math.min(flattened.length, start + width)
  return `${start > 0 ? '…' : ''}${flattened.slice(start, end)}${end < flattened.length ? '…' : ''}`
}
