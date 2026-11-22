/**
 * Model-facing memory tools.
 *
 * Readonly recall is unguarded: it can only return what is on disk, always
 * with a source. Writes are two-phase — `memory_candidate` stages a claim,
 * `memory_commit` promotes it — because a wrong long-term memory is re-injected
 * on every later step. Evidence is checked on both phases.
 *
 * @module @pseudo-agi/memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from './config.js'
import type { PseudoAgiMemoryRecallEvent } from './events.js'
import type { Evidence, MemoryLayer, MemoryStore } from './store.js'
import { MEMORY_LAYERS } from './store.js'
import type { BudgetEntry } from './budget.js'

/** Collaborators the memory tools need from the plugin body. */
export interface MemoryToolDeps {
  readonly store: MemoryStore
  readonly config: MemoryConfig
  /** Check that cited evidence exists; returns the refs that do not. */
  readonly verifyEvidence: (evidence: readonly Evidence[]) => Promise<string[]>
  /** Publish one recall observation for the governance layer. */
  readonly emitRecall: (event: PseudoAgiMemoryRecallEvent) => void
  /** Refresh the human-readable working-memory projection after a mutation. */
  readonly refreshDigest: () => Promise<void>
  /** Durable identity of the calling agent, or `'unknown'` outside an agent. */
  readonly sessionOf: (exec: { readonly agent?: { readonly id: string } }) => string
}

const EVIDENCE_KINDS = ['file', 'url', 'tool', 'session', 'user'] as const

/** Flatten a record body into one line for an injected block. */
function compact(text: string, width = 320): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length <= width ? flattened : `${flattened.slice(0, width)}…`
}

/** Render the recall result as model-facing text, including the miss case. */
function renderRecall(value: {
  readonly found: boolean
  readonly considered: number
  readonly note?: string
  readonly hits: readonly {
    readonly title: string
    readonly layer: string
    readonly score: number
    readonly excerpt: string
  }[]
}): string {
  if (!value.found) {
    return `未找到记忆（扫描 ${value.considered} 条）。${value.note ?? ''}`
  }
  const lines = value.hits.map((hit, index) =>
    `${index + 1}. [${hit.layer}] ${hit.title}（score ${hit.score.toFixed(2)}）\n   ${hit.excerpt}`)
  return `找到 ${value.hits.length} 条记忆，扫描 ${value.considered} 条：\n${lines.join('\n')}`
}

/**
 * Register the four memory tools on the calling context's tool registry.
 * Registrations are owned by the plugin fiber and disappear on unload.
 * @param ctx - the plugin context.
 * @param deps - store, config, and the evidence/observation seams.
 */
export function registerMemoryTools(ctx: Context, deps: MemoryToolDeps): void {
  const { store, config } = deps

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Search the layered long-term memory (working / episodic / semantic / procedural) and return '
      + 'the best matching records with their sources. Read-only. When nothing reliable is found, the '
      + 'result says so explicitly: never fill the gap with training knowledge.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for, in natural language.' },
      layers: {
        type: 'array',
        description: 'Restrict the search to these layers; defaults to the deployment setting.',
        items: { type: 'string', enum: [...MEMORY_LAYERS] },
      },
      limit: { type: 'integer', description: 'Maximum number of hits to return.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: 'Whether any hit passed both floors.' },
          considered: { type: 'integer', required: true, description: 'Records scanned.' },
          note: { type: 'string', description: 'Why nothing was returned, when nothing was.' },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                layer: { type: 'string', required: true, enum: [...MEMORY_LAYERS] },
                title: { type: 'string', required: true },
                score: { type: 'number', required: true },
                coverage: { type: 'number', required: true },
                updatedAt: { type: 'string', required: true },
                excerpt: { type: 'string', required: true },
                evidence: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, enum: [...EVIDENCE_KINDS] },
                      ref: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRecall(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const layers: readonly MemoryLayer[] = args.layers ?? config.recallLayers
      const limit = args.limit ?? config.recallLimit
      const result = await store.recall(args.query, {
        limit,
        minScore: config.minScore,
        minCoverage: config.minCoverage,
      }, layers)
      const found = result.hits.length > 0
      deps.emitRecall({
        sessionId: deps.sessionOf(exec),
        query: args.query,
        layers: [...layers],
        found,
        hitCount: result.hits.length,
        considered: result.considered,
        topScore: result.hits[0]?.score ?? 0,
        at: new Date().toISOString(),
      })
      return {
        found,
        considered: result.considered,
        hits: found
          ? result.hits.map(hit => ({
            id: hit.record.id,
            layer: hit.record.layer,
            title: hit.record.title,
            score: hit.score,
            coverage: hit.coverage,
            updatedAt: hit.record.updatedAt,
            excerpt: hit.excerpt,
            evidence: [...hit.record.evidence],
          }))
          : [],
        ...(found ? {} : {
          note: '证据不足：只能回答“没找到”，不要用训练知识补全，也不要据此假设事实存在。',
        }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate',
    description:
      'Stage a claim as a memory candidate. Candidates are NOT recalled or injected until committed. '
      + 'Every candidate must cite evidence; the filesystem is checked for `file` evidence when enabled. '
      + 'Prefer several small, single-fact candidates over one narrative.',
    parameters: {
      layer: {
        type: 'string',
        required: true,
        enum: [...MEMORY_LAYERS],
        description: 'Destination layer: working (this task), episodic (an event), semantic (a durable fact), procedural (how to do something).',
      },
      title: { type: 'string', required: true, description: 'One-line claim, as a statement.' },
      body: { type: 'string', required: true, description: 'The claim in detail, including scope and conditions.' },
      evidence: {
        type: 'array',
        required: true,
        description: 'What this claim rests on. At least one entry is mandatory.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: [...EVIDENCE_KINDS], description: 'file | url | tool | session | user.' },
            ref: { type: 'string', required: true, description: 'Workspace-relative path, URL, tool call id, session id, or user quote.' },
          },
        },
      },
      confidence: { type: 'number', description: '0..1; below the injection floor the record is stored but never injected.' },
      tags: { type: 'array', description: 'Retrieval tags.', items: { type: 'string' } },
      supersedes: {
        type: 'array',
        description: 'Ids of existing records this one replaces. They stay on disk as history but stop being recalled or injected. Use this instead of memory_forget when the new record corrects an old one.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string', required: true },
          layer: { type: 'string', required: true, enum: [...MEMORY_LAYERS] },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['pending'] },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已暂存候选 ${value.candidateId}（目标层 ${value.layer}），尚未进入记忆；需要 memory_commit 才会生效。`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const missing = await deps.verifyEvidence(args.evidence)
      if (missing.length > 0) {
        throw new Error(
          `证据校验失败：以下来源无法确认存在于工作区 —— ${missing.join(', ')}。`
          + '请先实际获取证据（检索、读取文件、工具结果），再重新提交候选。',
        )
      }
      const title = args.title.trim()
      const body = args.body.trim()
      if (title.length === 0) throw new Error('title 不能为空')
      if (body.length === 0) throw new Error('body 不能为空')
      const candidate = await store.writeCandidate({
        layer: args.layer,
        title,
        body,
        evidence: args.evidence,
        confidence: args.confidence ?? 0.6,
        tags: args.tags ?? [],
        ...args.supersedes !== undefined && args.supersedes.length > 0
          ? { supersedes: args.supersedes }
          : {},
      })
      return {
        candidateId: candidate.id,
        layer: candidate.layer,
        path: candidate.path,
        status: 'pending' as const,
        note: '候选不会被召回或注入；经人工或控制器批准后调用 memory_commit。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_commit',
    description:
      'Promote one staged candidate into its layer. This is the only path by which a claim becomes '
      + 'long-term memory, and it re-checks that the candidate still has evidence.',
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Id returned by memory_candidate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          layer: { type: 'string', required: true, enum: [...MEMORY_LAYERS] },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['committed'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已写入长期记忆 ${value.id}（${value.layer}）：${value.path}`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const candidates = await store.scanCandidates()
      const candidate = candidates.records.find(record => record.id === args.candidateId)
      if (candidate === undefined) {
        throw new Error(`找不到候选 "${args.candidateId}"；可能已提交或从未创建。现有候选：${
          candidates.records.map(record => record.id).join(', ') || '(none)'}`)
      }
      const missing = await deps.verifyEvidence(candidate.evidence)
      if (missing.length > 0) {
        throw new Error(`提交被拒绝：候选的证据已失效 —— ${missing.join(', ')}`)
      }
      const record = await store.commitCandidate(args.candidateId)
      await deps.refreshDigest()
      return { id: record.id, layer: record.layer, path: record.path, status: 'committed' as const }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one committed memory record by id. Irreversible in this session.',
    parameters: {
      id: { type: 'string', required: true, description: 'Record id, as returned by memory_recall.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已删除记忆 ${value.id}：${value.path}` }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const path = await store.remove(args.id)
      await deps.refreshDigest()
      return { id: args.id, removed: true, path }
    },
  }))
}

/** Exposed for the injection path so it uses the same block shape as recall. */
export function toBudgetEntry(record: {
  readonly id: string
  readonly title: string
  readonly layer: MemoryLayer
  readonly updatedAt: string
  readonly confidence: number
  readonly body: string
}): BudgetEntry {
  return {
    id: record.id,
    title: record.title,
    layer: record.layer,
    updatedAt: record.updatedAt,
    confidence: record.confidence,
    text: compact(record.body),
  }
}
