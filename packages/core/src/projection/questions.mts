// 提问：对面的一道题 → 界面看到的一道题；界面上各题填成了什么 → 回给对面的答案。纯函数。
// 一次请求里可以有好几道题（Claude Code 的提问工具一次 1 到 4 道），界面一道一道地问，可以来回翻、可以跳过。
import type { ToolRequestUserInputQuestion } from '../../../protocol/src/index.mjs'
import type { QuestionView } from '../model.mjs'

/**
 * 选项之外能不能自己填，只看题目上的 isOther（协议里的标记），不看选项叫什么。
 * 对面给的选项原样留着：其中一个就叫 Other 也一样，那是对面自己写的一个选项，选它回去的就是这个标签。
 * 用户自己填的字也原样回去，填的正好是 Other 也是一个答案。没有选项的题只能自己填。
 */
export function projectQuestion(question: ToolRequestUserInputQuestion): QuestionView {
  const options = question.options ?? []
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    options: options.length
      ? options.map(({ label, description }) => ({ label, description }))
      : null,
    allowOther: question.isOther || options.length === 0,
    secret: question.isSecret,
  }
}

/** 界面上一道题现在填成了什么。没有这一项就是还没碰过 */
export type QuestionEntry =
  | { kind: 'option'; label: string }
  /** 自己填。还没写出字来的不算答了 */
  | { kind: 'other'; text: string }
  /** 明确跳过：这道题不答 */
  | { kind: 'skipped' }

/** 题目标识 → 这道题填成了什么 */
export type QuestionEntries = Record<string, QuestionEntry>

/** open：还没答 */
export type QuestionState = 'open' | 'answered' | 'skipped'

export function questionState(entry: QuestionEntry | undefined): QuestionState {
  if (!entry) return 'open'
  if (entry.kind === 'skipped') return 'skipped'
  if (entry.kind === 'option') return 'answered'
  return entry.text.trim() ? 'answered' : 'open'
}

/** 一道题回给对面的答案：答了的是一个字符串，跳过的是空的 */
const answerOf = (entry: QuestionEntry | undefined): string[] => {
  if (entry?.kind === 'option') return [entry.label]
  if (entry?.kind === 'other' && entry.text.trim()) return [entry.text.trim()]
  return []
}

/**
 * 交卷：每道题都得有个说法，答了，或者明确跳过。
 * 都有了就给出按题目标识组织的答案；还有没答的，给出第一道没答的题排第几（从 0 数），不交。
 */
export function collectAnswers(
  questions: readonly QuestionView[],
  entries: QuestionEntries,
): { answers: Record<string, string[]> } | { open: number } {
  const open = questions.findIndex((question) => questionState(entries[question.id]) === 'open')
  if (open >= 0) return { open }
  const answers: Record<string, string[]> = {}
  for (const question of questions) answers[question.id] = answerOf(entries[question.id])
  return { answers }
}

/**
 * 界面交来的答案对着题目再查一遍，规整成每道题一个数组（跳过的是空数组）。有不对的返回 null：
 * 少了哪道题（跳过也得明说，给空的）、多出不认识的题、一道题给了不止一个答案、答案不是字或者是空白、
 * 不许自己填的题答了选项之外的东西。
 */
export function settleAnswers(
  questions: readonly QuestionView[],
  given: Record<string, unknown> | undefined,
): Record<string, string[]> | null {
  if (!given || typeof given !== 'object') return null
  const known = new Set(questions.map((question) => question.id))
  if (Object.keys(given).some((id) => !known.has(id))) return null
  const settled: Record<string, string[]> = {}
  for (const question of questions) {
    const list = given[question.id]
    if (!Array.isArray(list) || list.length > 1) return null
    const answer: unknown = list[0]
    if (answer === undefined) {
      settled[question.id] = []
      continue
    }
    if (typeof answer !== 'string' || !answer.trim()) return null
    // 选项的标签原样回去，对面是按它认的；自己填的去掉两头的空白
    const listed = question.options?.some((option) => option.label === answer) ?? false
    if (!listed && !question.allowOther) return null
    settled[question.id] = [listed ? answer : answer.trim()]
  }
  return settled
}
