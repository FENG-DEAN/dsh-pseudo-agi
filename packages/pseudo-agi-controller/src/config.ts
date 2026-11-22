/**
 * Configuration for the routing controller.
 *
 * @module @pseudo-agi/controller/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. */
export interface ControllerConfig {
  /** Master switch; `false` loads the plugin as a no-op. */
  readonly enabled: boolean
  /** Maximum directives injected per turn. */
  readonly injectPerTurn: number
  /** Messages shorter than this are routed to `clarify`. */
  readonly minPromptChars: number
  /** Whether answers without retrieval must be marked unverified. */
  readonly requireEvidence: boolean
  /** Steer once per turn when a recall came back empty. Off by default. */
  readonly reflectOnEmptyRecall: boolean
  /** Words that route a prompt to `recall-first`. */
  readonly recallKeywords: string[]
  /** Words that route a prompt to `act-with-approval`. */
  readonly writeKeywords: string[]
}

/** Schemastery schema; invalid config fails at load time. */
export const Config: z<ControllerConfig> = z.object({
  enabled: z.boolean().default(true),
  injectPerTurn: z.number().default(2),
  minPromptChars: z.number().default(8),
  requireEvidence: z.boolean().default(true),
  reflectOnEmptyRecall: z.boolean().default(false),
  recallKeywords: z.array(z.string()).default([
    '查', '检索', '搜索', '查找', '资料', '文档', '知识库', '记忆', '上次', '之前',
    '依据', '来源', '引用', '证据', '文档里', '记录里', 'search', 'lookup', 'recall',
    'document', 'source', 'reference', 'evidence',
  ]),
  writeKeywords: z.array(z.string()).default([
    '写', '创建', '新建', '修改', '编辑', '删除', '保存', '生成文件', '覆盖', '追加',
    '提交', '部署', '写入', 'create', 'write', 'edit', 'delete', 'save', 'commit', 'deploy',
  ]),
})

/**
 * Assert bounds Schemastery cannot express.
 * @param config - the resolved configuration.
 */
export function validateConfig(config: ControllerConfig): void {
  const fail = (message: string): never => {
    throw new Error(`pseudo-agi-controller: ${message}`)
  }
  for (const [name, value] of [
    ['injectPerTurn', config.injectPerTurn],
    ['minPromptChars', config.minPromptChars],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      fail(`config.${name} must be a non-negative integer`)
    }
  }
  if (config.recallKeywords.length === 0) fail('config.recallKeywords must not be empty')
  if (config.writeKeywords.length === 0) fail('config.writeKeywords must not be empty')
}
