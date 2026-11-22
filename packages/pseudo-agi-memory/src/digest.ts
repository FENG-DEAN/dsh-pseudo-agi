/**
 * Human-readable working-memory digest.
 *
 * Written to `<root>/../working.md` when the tree actually changed, so the
 * projection is cheap to keep current and never churns on an idle step. It
 * exists so a person (and the controller) can read "what does this agent
 * currently believe" without parsing front matter — and so the digest stays
 * inspectable even if every plugin is unloaded.
 *
 * @module @pseudo-agi/memory/digest
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { MemoryStore } from './store.js'

/**
 * Rewrite the digest if the memory tree changed since `previousKey`.
 *
 * The key covers record count, candidate count, and the newest `updatedAt`, so
 * an appended record or a re-committed one invalidates it while a plain recall
 * does not. The digest is a projection: losing it costs nothing, which is why a
 * failure here is reported rather than thrown.
 *
 * @param store - the memory store to summarize.
 * @param previousKey - key returned by the last successful refresh, if any.
 * @returns the new key, or `undefined` when the digest was already current.
 */
export async function refreshWorkingDigest(store: MemoryStore, previousKey?: string): Promise<string | undefined> {
  const scanned = await store.scan()
  const candidates = await store.scanCandidates()
  const newest = scanned.records.reduce(
    (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
    '',
  )
  const key = `${scanned.records.length}|${candidates.records.length}|${newest}`
  if (key === previousKey) return undefined

  const path = resolve(store.root, '..', 'working.md')
  const counts = new Map<string, number>()
  for (const record of scanned.records) counts.set(record.layer, (counts.get(record.layer) ?? 0) + 1)
  const layerLines = [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([layer, count]) => `- ${layer}: ${count}`)

  const recent = [...scanned.records]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map(record => `- [${record.layer}] ${record.title}（更新于 ${record.updatedAt.slice(0, 10)}，证据 ${
      record.evidence.map(item => item.ref).join('; ')}）`)

  const pending = [...candidates.records]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5)
    .map(record => `- ${record.id} → ${record.layer}: ${record.title}`)

  const lines = [
    '# 工作记忆摘要（自动生成，请勿手改）',
    '',
    `生成时间：${new Date().toISOString()}`,
    `存储根目录：${store.root}`,
    '',
    '## 分层计数',
    ...(layerLines.length > 0 ? layerLines : ['- (empty)']),
    '',
    '## 最近更新的记忆',
    ...(recent.length > 0 ? recent : ['- (empty)']),
    '',
    '## 待批准的候选',
    ...(pending.length > 0 ? pending : ['- (none)']),
    '',
    '> 本文件是投影，不是真源。真正的记忆是 memory 目录下的 Markdown 文件；删掉本文件不会丢信息。',
    '',
  ]

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.join('\n'), 'utf8')
  return key
}
