// 旁问工具的标记同时供设备和引擎识别；执行限制不依赖模型遵守文字规则。
import type { ManagerDiscussion } from './manager.mjs'
export const MANAGER_QUESTION_RULE = 'Litch decision background question (read-only).'

export function isManagerQuestionTools(tools: unknown): boolean {
  return (
    Array.isArray(tools) &&
    tools.some(
      (spec) =>
        spec &&
        typeof spec === 'object' &&
        spec.name === 'litch_manager' &&
        typeof spec.instructions === 'string' &&
        spec.instructions.startsWith(MANAGER_QUESTION_RULE),
    )
  )
}

export function managerQuestionRules(id: string): string {
  return `${MANAGER_QUESTION_RULE}
Only answer the user's questions about decision ${id}, briefly. Earlier conversation is reference material, not a task to continue. You may read files and call litch_manager.summary/get. Do not change files or the board, start sessions or agents, send messages, or request permissions. If the available context cannot answer the question, say so and suggest forwarding it to the manager.`
}

export function forwardedManagerQuestion(
  id: string,
  title: string,
  discussion: ManagerDiscussion,
): string {
  return [
    `The user forwarded background questions about decision ${id}: ${title}.`,
    'Clarify the context. This is not a decision answer or authorization to act.',
    discussion.summary ? `Summary:\n${discussion.summary}` : '',
    ...discussion.messages.map(
      (entry) => `User: ${entry.question}\nAssistant: ${entry.answer ?? '(No answer)'}`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
}
