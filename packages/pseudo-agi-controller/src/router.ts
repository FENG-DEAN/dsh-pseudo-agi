/**
 * Routing: a small, inspectable decision procedure, not a second model.
 *
 * The controller's job is to choose a *route* and attach the constraints that
 * route implies. It never produces the answer, and it never decides whether
 * evidence is sufficient — only that evidence must be sought and cited.
 *
 * @module @pseudo-agi/controller/router
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** The four routes the controller can take. */
export type Route = 'direct' | 'recall-first' | 'act-with-approval' | 'clarify'

/** Inputs to one routing decision. */
export interface RouteInput {
  /** The latest user text entering this step. */
  readonly text: string
  /** Whether a recall tool is visible to this agent right now. */
  readonly hasRecallTool: boolean
  /** Whether a guarded write tool is visible right now. */
  readonly hasWriteTool: boolean
  /** Whether answers must be backed by evidence. */
  readonly requireEvidence: boolean
  /** Recall trigger words. */
  readonly recallKeywords: readonly string[]
  /** Write trigger words. */
  readonly writeKeywords: readonly string[]
  /** Minimum prompt length before routing instead of clarifying. */
  readonly minPromptChars: number
}

/** One routing decision, with the constraints it implies. */
export interface RouteDecision {
  readonly route: Route
  readonly reason: string
  readonly directives: readonly string[]
  readonly matched: readonly string[]
}

/**
 * Extract the latest user text from the messages entering a step.
 * @param messages - messages admitted by the loop.
 * @returns the text of the last non-empty user message, or `''`.
 */
export function lastUserText(messages: readonly UserMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
    const text = parts.join('\n').trim()
    if (text.length > 0) return text
  }
  return ''
}

/** Words present in the text, case-insensitively. */
function matches(text: string, keywords: readonly string[]): string[] {
  const lowered = text.toLowerCase()
  return keywords.filter(keyword => keyword.length > 0 && lowered.includes(keyword.toLowerCase()))
}

/**
 * Decide the route for one step.
 * @param input - prompt text, visible tools, and policy words.
 * @returns the route plus the directive lines to inject.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const text = input.text.trim()
  if (text.length === 0) {
    return {
      route: 'clarify',
      reason: '本步没有用户文本（可能是工具结果续步）',
      matched: [],
      directives: ['本步是续步：继续已有计划，不要重新猜测用户目标。'],
    }
  }
  if (text.length < input.minPromptChars) {
    return {
      route: 'clarify',
      reason: `用户输入过短（< ${input.minPromptChars} 字符）`,
      matched: [],
      directives: ['信息不足：先用一句话确认目标与范围，不要猜测或自行扩大任务。'],
    }
  }

  const recallHits = matches(text, input.recallKeywords)
  const writeHits = matches(text, input.writeKeywords)

  if (writeHits.length > 0 && input.hasWriteTool) {
    return {
      route: 'act-with-approval',
      reason: `命中写操作词：${writeHits.slice(0, 3).join(', ')}`,
      matched: writeHits,
      directives: [
        '本步涉及写操作：写工具会触发审批，审批只覆盖这一次调用。',
        '先说明要改哪个文件、改什么、为什么；一次只改一件事。',
        '被拒绝或失败时停下来向用户汇报，不要换一条路径绕过审批。',
      ],
    }
  }

  if (recallHits.length > 0 && input.hasRecallTool) {
    return {
      route: 'recall-first',
      reason: `命中检索词：${recallHits.slice(0, 3).join(', ')}`,
      matched: recallHits,
      directives: [
        '本步必须先取证：调用 memory_recall 和/或 kb_search，再组织答案。',
        '每个事实性断言都要带来源（记忆 id，或 path:line）。',
        '检索结果为空时，明确回答“没找到”，不得用训练知识补全，也不得编造来源。',
      ],
    }
  }

  if (writeHits.length > 0 && !input.hasWriteTool) {
    return {
      route: 'direct',
      reason: '命中写操作词，但本 agent 看不到受控写工具',
      matched: writeHits,
      directives: [
        '本 agent 没有可用的写工具：不要声称已修改任何文件，改为给出具体改法或请求授权。',
      ],
    }
  }

  if (recallHits.length > 0 && !input.hasRecallTool) {
    return {
      route: 'direct',
      reason: '命中检索词，但本 agent 看不到检索工具',
      matched: recallHits,
      directives: [
        '本 agent 没有检索工具：凡未经核实的说法都必须标注为未经验证，并说明缺少什么证据。',
      ],
    }
  }

  return {
    route: 'direct',
    reason: '未命中任何路由词',
    matched: [],
    directives: input.requireEvidence
      ? ['可直接回答；但事实性断言若无检索来源，必须标注“未经验证”。']
      : ['可直接回答。'],
  }
}

/**
 * Compose the single directive message injected into one step.
 * @param decision - the routing decision.
 * @returns the message text, bounded to a few lines.
 */
export function directiveText(decision: RouteDecision): string {
  return [
    `[伪AGI·控制器] 路由=${decision.route}（${decision.reason}）。`,
    ...decision.directives.map(line => `- ${line}`),
    '以上是本步的执行约束，不是用户提出的新需求。',
  ].join('\n')
}
