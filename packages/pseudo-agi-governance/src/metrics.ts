/**
 * In-memory metric book plus an append-only JSONL journal.
 *
 * Metrics answer "is it getting better or just repeating itself": completion
 * rate, tool failure rate, memory hit rate, and how often the controller had to
 * intervene. The journal is the replayable record behind those numbers.
 *
 * @module @pseudo-agi/governance/metrics
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Aggregated counters for one session. */
export interface SessionMetrics {
  readonly sessionId: string
  firstAt: string
  lastAt: string
  turns: number
  steps: number
  toolCalls: number
  toolFailures: number
  memoryRecalls: number
  memoryHits: number
  controllerDecisions: number
  controllerInjections: number
  errors: number
  /** Route name → count. */
  routes: Record<string, number>
}

/** One journal line. */
export interface JournalRecord {
  readonly at: string
  readonly sessionId: string
  readonly kind: string
  readonly detail: Record<string, unknown>
}

/** Keep only filesystem-safe characters in a session id. */
function safeName(sessionId: string): string {
  const cleaned = sessionId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // Collapse dot runs: `../../escape` must never survive as a relative path.
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'unknown'
}

/**
 * Bounded metric book. Insertion order doubles as a simple eviction queue.
 */
export class MetricsBook {
  private readonly sessions = new Map<string, SessionMetrics>()

  constructor(private readonly capacity: number) {}

  /**
   * Read or create one session's counters.
   * @param sessionId - durable session identity.
   * @returns the mutable counters.
   */
  of(sessionId: string): SessionMetrics {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const now = new Date().toISOString()
    const created: SessionMetrics = {
      sessionId,
      firstAt: now,
      lastAt: now,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      toolFailures: 0,
      memoryRecalls: 0,
      memoryHits: 0,
      controllerDecisions: 0,
      controllerInjections: 0,
      errors: 0,
      routes: {},
    }
    this.sessions.set(sessionId, created)
    if (this.sessions.size > this.capacity) {
      const oldest = this.sessions.keys().next()
      if (!oldest.done) this.sessions.delete(oldest.value)
    }
    return created
  }

  /**
   * Snapshot the counters, most recently active first.
   * @param limit - maximum number of sessions.
   * @returns detached copies.
   */
  snapshot(limit = 20): SessionMetrics[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.lastAt.localeCompare(left.lastAt))
      .slice(0, limit)
      .map(metrics => ({ ...metrics, routes: { ...metrics.routes } }))
  }
}

/**
 * Append-only JSONL journal. Writes are serialized through one promise chain so
 * lines never interleave, and failures are reported once instead of throwing
 * into the event bus.
 */
export class JsonlJournal {
  private readonly directory: string
  private queue: Promise<void> = Promise.resolve()
  private prepared: Promise<void> | undefined
  private failed = false

  constructor(root: string, private readonly report: (message: string) => void) {
    this.directory = resolve(root)
  }

  /**
   * Queue one record for append.
   * @param record - the fully-formed journal line.
   */
  write(record: JournalRecord): void {
    this.queue = this.queue.then(async () => {
      this.prepared ??= mkdir(this.directory, { recursive: true }).then(() => undefined)
      await this.prepared
      await appendFile(
        join(this.directory, `${safeName(record.sessionId)}.jsonl`),
        `${JSON.stringify(record)}\n`,
        'utf8',
      )
    }).catch((error: unknown) => {
      if (this.failed) return
      this.failed = true
      this.report(`journal write failed (further failures are muted): ${String(error)}`)
    })
  }

  /**
   * Read the tail of one session's journal.
   * @param sessionId - durable session identity.
   * @param maxLines - maximum trailing lines.
   * @returns parsed records, oldest first.
   */
  async tail(sessionId: string, maxLines: number): Promise<JournalRecord[]> {
    let text: string
    try {
      text = await readFile(join(this.directory, `${safeName(sessionId)}.jsonl`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n').filter(line => line.trim().length > 0)
    const tail = lines.slice(Math.max(0, lines.length - maxLines))
    const records: JournalRecord[] = []
    for (const line of tail) {
      try {
        records.push(JSON.parse(line) as JournalRecord)
      } catch {
        // A torn trailing line is expected after a crash; skip it.
      }
    }
    return records
  }

  /** Resolve after every queued write has settled. */
  async flush(): Promise<void> {
    await this.queue
  }
}
