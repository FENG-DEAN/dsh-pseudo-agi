/**
 * The three tools of the controlled-hands layer.
 *
 * Readonly access (`kb_search`, `kb_read`) is deliberately permissive but
 * evidence-bearing: every hit carries `path:line`, and a miss says so instead of
 * letting the model summarize from memory.
 *
 * The one write tool (`controlled_write`) is guarded three times: this body
 * re-validates containment (async, after the synchronous guard), the guard
 * denies out-of-policy paths monotonically, and `tools/pre-execute` asks the
 * approval service in between.
 *
 * @module @pseudo-agi/tools/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolsConfig } from './config.js'
import { denyReason, isWritable, resolveInside } from './workspace.js'

/** Extensions the readonly walk considers text. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.toml', '.log', '.rst',
])

/** Collaborators a tool body needs. */
export interface ToolDeps {
  readonly config: ToolsConfig
  /** Absolute workspace root. */
  readonly root: string
}

/** One line hit of a knowledge-base search. */
interface SearchHit {
  path: string
  line: number
  text: string
}

/**
 * Turn a free-form query into literal match terms. Literal matching is the
 * point: a search tool that "understands" is a search tool that can invent.
 * @param query - the model-supplied query.
 * @returns up to 16 distinct lower-cased terms.
 */
function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const word of query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (word.length === 0) continue
    if (/^[a-z0-9_]+$/.test(word)) {
      if (word.length >= 2) terms.add(word)
      continue
    }
    terms.add(word)
    for (let index = 0; index + 1 < word.length; index++) terms.add(word.slice(index, index + 2))
  }
  return [...terms].slice(0, 16)
}

/** Whether a path segment is denied by policy. */
function deniedSegment(config: ToolsConfig, name: string): boolean {
  return config.deniedSegments.some(segment => segment.toLowerCase() === name.toLowerCase())
}

/**
 * Depth-bounded, denial-aware directory walk. Hidden entries are always
 * skipped; the caller owns the extension filter.
 * @param directory - absolute directory to walk.
 * @param depth - current depth.
 * @param config - deployment config (depth bound and denied segments).
 * @returns absolute file paths.
 */
async function* walkFiles(directory: string, depth: number, config: ToolsConfig): AsyncGenerator<string> {
  if (depth > config.maxDepth) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return
    throw error
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (deniedSegment(config, entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(path, depth + 1, config)
    } else if (entry.isFile()) {
      yield path
    }
  }
}

/** Render a relative path with forward slashes for stable citations. */
function cite(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

/**
 * Register the controlled-hands tools.
 * @param ctx - plugin context (tool registrations are fiber-owned).
 * @param deps - config and workspace root.
 */
export function registerControlledTools(ctx: Context, deps: ToolDeps): void {
  const { config, root } = deps

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description:
      'Literal, case-insensitive search over the workspace knowledge base (Markdown/text files). '
      + 'Returns every hit as path:line with the matching text. Read-only. When nothing matches, the '
      + 'result says `found: false` — answer that nothing was found instead of relying on training knowledge.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal words or phrases to look for.' },
      roots: {
        type: 'array',
        description: 'Directories to search, relative to the workspace root. Defaults to the deployment setting.',
        items: { type: 'string' },
      },
      limit: { type: 'integer', description: 'Maximum number of line hits (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          scannedFiles: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `命中 ${value.hits.length} 行（扫描 ${value.scannedFiles} 个文件）：\n`
            + value.hits.map(hit => `- ${hit.path}:${hit.line}  ${hit.text}`).join('\n')
          : `未找到匹配（扫描 ${value.scannedFiles} 个文件）。${value.note ?? ''}`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const terms = queryTerms(args.query)
      if (terms.length === 0) {
        return { found: false, scannedFiles: 0, hits: [], note: '查询为空：请给出实际要查找的词。' }
      }
      const limit = args.limit ?? 20
      const roots = (args.roots ?? config.knowledgeRoots).map(candidate => resolveInside(root, candidate))
      const hits: SearchHit[] = []
      let scannedFiles = 0

      search: for (const directory of roots) {
        for await (const file of walkFiles(directory, 0, config)) {
          exec.signal.throwIfAborted()
          if (hits.length >= limit) break search
          const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
          if (!TEXT_EXTENSIONS.has(extension)) continue
          let size: number
          try {
            const info = await stat(file)
            if (!info.isFile()) continue
            size = info.size
          } catch {
            continue
          }
          if (size > config.maxScanBytes) continue
          let text: string
          try {
            text = await readFile(file, 'utf8')
          } catch {
            continue
          }
          scannedFiles++
          const lines = text.split(/\r?\n/)
          for (let index = 0; index < lines.length; index++) {
            if (hits.length >= limit) break search
            const line = lines[index]
            if (line === undefined) continue
            const lowered = line.toLowerCase()
            if (!terms.some(term => lowered.includes(term))) continue
            hits.push({
              path: cite(root, file),
              line: index + 1,
              text: line.trim().slice(0, config.maxSnippetChars),
            })
          }
        }
      }

      const found = hits.length > 0
      return {
        found,
        scannedFiles,
        hits,
        ...(found ? {} : {
          note: '证据不足：只能回答“没找到”，不要用训练知识补全，也不要编造文件或引用。',
        }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_read',
    description:
      'Read one text file from the workspace, optionally a line range. Read-only. Every result is '
      + 'attributed to its path; content beyond the file is never invented.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative file path.' },
      start: { type: 'integer', description: 'First line, 1-based (default 1).' },
      end: { type: 'integer', description: 'Last line, inclusive (default start + 199).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          startLine: { type: 'integer', required: true },
          endLine: { type: 'integer', required: true },
          totalLines: { type: 'integer', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.path}:${value.startLine}-${value.endLine}（共 ${value.totalLines} 行）\n\n${value.content}`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const absolute = resolveInside(root, args.path)
      const denial = denyReason(config, root, absolute)
      if (denial !== undefined) throw new Error(denial)
      const info = await stat(absolute)
      if (!info.isFile()) throw new Error(`不是普通文件：${args.path}`)
      if (info.size > config.maxScanBytes) {
        throw new Error(`文件过大（${info.size} bytes，上限 ${config.maxScanBytes}）：请先检索再按行读取。`)
      }
      const text = await readFile(absolute, 'utf8')
      const lines = text.split(/\r?\n/)
      const totalLines = lines.length
      const startLine = Math.max(1, Math.min(args.start ?? 1, totalLines))
      const endLine = Math.max(startLine, Math.min(args.end ?? startLine + 199, totalLines))
      const content = lines.slice(startLine - 1, endLine).join('\n')
      return {
        path: cite(root, absolute),
        startLine,
        endLine,
        totalLines,
        content,
        truncated: endLine < totalLines,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'controlled_write',
    description:
      'Write or append one UTF-8 text file inside the workspace write roots. This tool is guarded and '
      + 'requires approval: out-of-root paths, denied segments (e.g. .git), and denied extensions are '
      + 'rejected even if approved. Prefer small, reviewable writes over large rewrites.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative destination path.' },
      content: { type: 'string', required: true, description: 'Complete UTF-8 text to write.' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: 'overwrite (default) replaces the file; append adds to the end.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          created: { type: 'boolean', required: true },
          mode: { type: 'string', required: true, enum: ['overwrite', 'append'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已写入 ${value.path}（${value.bytes} bytes，模式 ${value.mode}${value.created ? '，新建' : '，追加'}）`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const absolute = resolveInside(root, args.path)
      if (!isWritable(config, root, absolute)) {
        throw new Error(`目标不在允许的写入根目录内：${config.writeRoots.join(', ')}`)
      }
      const denial = denyReason(config, root, absolute)
      if (denial !== undefined) throw new Error(denial)

      const mode = args.mode ?? 'overwrite'
      if (Buffer.byteLength(args.content, 'utf8') > config.maxWriteBytes) {
        throw new Error(`内容过大（上限 ${config.maxWriteBytes} bytes）`)
      }

      let payload = args.content
      let created = true
      if (mode === 'append') {
        try {
          payload = `${await readFile(absolute, 'utf8')}${args.content}`
          created = false
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT') throw error
        }
        if (Buffer.byteLength(payload, 'utf8') > config.maxWriteBytes * 2) {
          throw new Error(`追加后内容过大（上限 ${config.maxWriteBytes * 2} bytes）`)
        }
      }

      await mkdir(dirname(absolute), { recursive: true })
      const temporary = `${absolute}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(temporary, payload, 'utf8')
      try {
        // Never leave a half-written file behind a cancellation.
        exec.signal.throwIfAborted()
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      await rename(temporary, absolute)
      return {
        path: cite(root, absolute),
        bytes: Buffer.byteLength(payload, 'utf8'),
        created,
        mode,
      }
    },
  }))
}
