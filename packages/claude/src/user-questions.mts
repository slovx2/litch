// 提问（AskUserQuestion）与计划确认（ExitPlanMode）的桥接：模型出的题 → 协议里的题，
// 客户端按题交回的答案 → 交还给 CLI 的内容。都是纯函数。
//
// 一条规矩管到底：选项原样给客户端、原样收回来；答案里是什么字，就给模型什么字。
// “都不是，我自己说”这个入口用协议里题目上的 isOther 表示，由客户端自己画。引擎不往选项里塞东西，
// 也不按文字去猜哪个答案是“其他”：模型自己写的选项可以就叫 Other，用户自己填的字也可以正好是 Other。
import type { UserInputAnswers, UserInputQuestion } from './types.mjs'

type AnswerSlot = UserInputAnswers['answers'][string] | undefined

// 模型出的题（SDK 的 AskUserQuestionInput：`{questions: [{question, header, options: [{label,
// description, preview?}], multiSelect}]}`，一次 1 到 4 道）→ 协议里的题。
// 这个工具对用户总是另有一个“自己说”的入口（工具说明里要模型别自己列 Other），所以每道题都标 isOther。
// 协议的题目上没有多选的标记，multiSelect 带不过去：多选题到客户端和单选题是一个样子。
export function parseAskUserQuestions(input: Record<string, unknown>): UserInputQuestion[] {
  const raw = (input.questions as Array<Record<string, unknown>>) || []
  const out: UserInputQuestion[] = []
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] || {}
    const header = String(q.header ?? `Question ${i + 1}`)
    const question = String(q.question ?? '')
    const optionsRaw = (q.options as Array<Record<string, unknown>>) || []
    const options = optionsRaw.map((o) => ({
      label: String(o.label ?? ''),
      description: String(o.description ?? ''),
    }))
    out.push({
      id: `q${i}`,
      header: header.slice(0, 12),
      question,
      isOther: true,
      isSecret: false,
      options,
    })
  }
  return out
}

/** 一道题交回来的答案，去掉没有字的。一个都不剩就是这道题没有回答 */
function givenAnswers(slot: AnswerSlot): string[] {
  return (slot?.answers ?? []).filter((answer) => answer.trim() !== '')
}

/** 应答里另附的备注。不是标准协议的字段，带了就收 */
function givenNotes(slot: AnswerSlot): string | null {
  return typeof slot?.notes === 'string' && slot.notes.trim() !== '' ? slot.notes : null
}

// 一道题交回几个答案（多选题）时，按 CLI 自己的写法连成一个字符串：逗号加空格；
// 答案里本身带这个分隔或带双引号的，整个按 JSON 的写法括起来，CLI 才拆得回原来的几项。
// 只有一个答案时不动它：那可能是用户自己写的一句话，原样交给模型。
function joinAnswers(list: string[]): string {
  if (list.length === 1) return list[0] as string
  return list
    .map((answer) =>
      answer.includes(', ') || answer.includes('"') ? JSON.stringify(answer) : answer,
    )
    .join(', ')
}

/** 一道题的回答连成的字。空串就是没有回答（跳过了，或者应答里没有这道题） */
export function answerText(slot: AnswerSlot): string {
  const given = givenAnswers(slot)
  if (given.length > 0) return joinAnswers(given)
  return givenNotes(slot) ?? ''
}

// 答案交还给 CLI：按 SDK 的约定放进原生 AskUserQuestion 的 updatedInput，CLI 自己写成工具结果给模型。
// CLI 按题面文字认答案；没有回答的题给空串，CLI 不把它列给模型，一道都没答时说“用户没有回答”。
export function askUserQuestionUpdatedInput(
  input: Record<string, unknown>,
  questions: UserInputQuestion[],
  answers: UserInputAnswers,
): Record<string, unknown> {
  const original = (input.questions as Array<Record<string, unknown>>) || []
  const answersByQuestion: Record<string, string> = {}
  const annotations: Record<string, { notes: string }> = {}
  for (const [i, q] of questions.entries()) {
    const questionText = String(original[i]?.question ?? q.question)
    const slot = answers.answers[q.id]
    answersByQuestion[questionText] = answerText(slot)
    // 有答案又另附了备注：备注跟在这道题的答案后面。只有备注时它已经是答案了，不重复一遍
    const notes = givenNotes(slot)
    if (notes && givenAnswers(slot).length > 0) annotations[questionText] = { notes }
  }
  return {
    questions: original,
    answers: answersByQuestion,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  }
}

// ── 计划确认 ──
//
// 模型要退出计划模式（ExitPlanMode）时，引擎自己出一道题问用户，走的是同一条提问的路，但含义不同：
// 普通提问的答案是交给模型的内容，工具调用总是成功的；这里的答案是一个权限决定，
// 选了“执行计划”才放行，别的一律不放行，模型看到的是这次调用被拒绝。
// 做法照官方桌面端的计划确认：一道题，选“执行”就执行，另外能写字。

export const PLAN_EXIT_QUESTION_ID = 'execute_plan'
export const PLAN_EXECUTE = '执行计划'
export const PLAN_KEEP = '继续规划'
export const PLAN_NOT_CONFIRMED = '用户尚未确认执行，继续保持计划模式。'
// 入口不问、把计划交给客户端去问时拒绝 ExitPlanMode 的说法（见 native-runtime.mts 的 planHandoff）
export const PLAN_HANDED_OFF = '计划已交给用户审阅，等用户决定是否执行。'

export function planExitQuestion(): UserInputQuestion {
  return {
    id: PLAN_EXIT_QUESTION_ID,
    header: PLAN_EXECUTE,
    question: '计划已完成，是否退出计划模式并按当前权限执行？',
    // 选项之外可以自己写：写的是对这份计划的意见，见 planExitVerdict
    isOther: true,
    isSecret: false,
    options: [
      { label: PLAN_EXECUTE, description: '退出计划模式，继续执行已确认的计划。' },
      { label: PLAN_KEEP, description: '保持计划模式，不执行修改。' },
    ],
  }
}

export type PlanExitVerdict =
  | { execute: true; note: string | null }
  | { execute: false; message: string }

// 计划确认的裁决。
// - 选了“执行计划”就是确认。一起带着的话（另附的备注、答案里多出来的几句）是执行时的补充，
//   不挡放行，随计划一起交给模型（见 planWithNote）。
// - 没选“执行计划”、只写了话：那是对这份计划的意见，不放行，原话跟在“没有确认”后面交给模型，
//   模型改了计划再来问。
// - 没答、跳过、选了“继续规划”：没有确认。“执行计划”和“继续规划”都选了，自相矛盾，也按没有确认算。
export function planExitVerdict(slot: AnswerSlot): PlanExitVerdict {
  const given = givenAnswers(slot).map((answer) => answer.trim())
  const notes = givenNotes(slot)
  const said = given.filter((answer) => answer !== PLAN_EXECUTE && answer !== PLAN_KEEP)
  if (notes) said.push(notes.trim())
  if (given.includes(PLAN_EXECUTE) && !given.includes(PLAN_KEEP))
    return { execute: true, note: said.length > 0 ? said.join('\n') : null }
  if (said.length === 0) return { execute: false, message: PLAN_NOT_CONFIRMED }
  return {
    execute: false,
    message: `${PLAN_NOT_CONFIRMED}\n用户对这份计划说：\n${said.join('\n')}`,
  }
}

export const PLAN_NOTE_HEADING = '## 用户确认执行时的补充'

// 确认执行时带的补充并进计划的末尾。放行时把它作为改过的计划交回 CLI：
// CLI 认出计划被用户改过，会把这一份写回计划文件，并在工具结果里原样回给模型，补充就到了模型手里。
// 还没有成文的计划时，补充自己就是全部内容。
export function planWithNote(plan: unknown, note: string): string {
  const body = typeof plan === 'string' ? plan.trimEnd() : ''
  return `${body ? `${body}\n\n` : ''}${PLAN_NOTE_HEADING}\n\n${note}\n`
}
