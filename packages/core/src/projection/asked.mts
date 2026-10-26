// 问用户的工具（Claude 的 AskUserQuestion、OpenCode 的 question、dsh 的 ask_user_question）→ 问答卡片的数据。纯函数。
// 三个入口约定一样（实时回合和读历史也一样）：一个动态工具条目，参数是发给客户端的那几道题
// `{questions: [{id, header, question, options: [{label, description}] | null}]}`；答完以后结果是每道题一行
// “题头: 回答”（没答的是 “(no answer)”），按题的先后。对不上这个样子的结果（没问成时引擎的报错、
// 认不出的原始输出）整段留作原始回答，界面照题目加原文画。
// 问的时候用户在请求卡片（item/tool/requestUserInput）上答，这里只管答完以后、读历史时怎么画。
import type { AskedQuestion, AskedView } from '../model.mjs'

/** 各入口问用户的工具：命名空间 → 工具名 */
const ASK_TOOLS: Record<string, string> = {
  claude: 'AskUserQuestion',
  opencode: 'question',
  dsh: 'ask_user_question',
}

/** 引擎写“没答这一题”的说法 */
const NO_ANSWER = '(no answer)'

interface RawQuestion {
  header: string
  question: string
  options: { label: string; description: string }[]
}

function questionsOf(args: unknown): RawQuestion[] | null {
  const list = (args as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list) || list.length === 0) return null
  const out: RawQuestion[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null
    const { header, question, options } = entry as Record<string, unknown>
    if (typeof question !== 'string') return null
    out.push({
      header: typeof header === 'string' ? header : '',
      question,
      options: (Array.isArray(options) ? options : []).flatMap((option) => {
        const { label, description } = (option ?? {}) as Record<string, unknown>
        return typeof label === 'string' && label !== ''
          ? [{ label, description: typeof description === 'string' ? description : '' }]
          : []
      }),
    })
  }
  return out
}

/** 结果里的文字段，按先后 */
function textsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) =>
    typeof part === 'object' && part !== null && typeof part.text === 'string' ? [part.text] : [],
  )
}

/**
 * 一个回答拆成几项：多选时几项用“, ”连着，项里本身带“, ”或双引号的按 JSON 字符串括起来（Claude 入口的写法）。
 * 拆不开（引号没配对）就当一整项
 */
export function answerParts(answer: string): string[] {
  const parts: string[] = []
  let rest = answer
  while (rest !== '') {
    if (rest.startsWith('"')) {
      // 找到能整段解析成 JSON 字符串、后面紧跟“, ”或到头的那个引号
      let end = rest.indexOf('"', 1)
      let taken: string | null = null
      while (end > 0) {
        const after = rest.slice(end + 1)
        if (after === '' || after.startsWith(', ')) {
          try {
            taken = JSON.parse(rest.slice(0, end + 1)) as string
            break
          } catch {}
        }
        end = rest.indexOf('"', end + 1)
      }
      if (taken === null) return [answer]
      parts.push(taken)
      rest = rest.slice(end + 1).replace(/^, /, '')
      continue
    }
    const at = rest.indexOf(', ')
    parts.push(at < 0 ? rest : rest.slice(0, at))
    rest = at < 0 ? '' : rest.slice(at + 2)
  }
  return parts
}

/** 一道题的回答：选中了哪几项，哪部分是自己写的。一项都对不上选项的整段算自己写的（那段话里本来就可能有逗号） */
function answered(question: RawQuestion, answer: string | null): AskedQuestion {
  const base = { ...question, answer, picked: [] as number[], other: null as string | null }
  if (answer === null) return base
  const labels = question.options.map((option) => option.label)
  const whole = labels.indexOf(answer)
  if (whole >= 0) return { ...base, picked: [whole] }
  const parts = answerParts(answer)
  const picked = parts.map((part) => labels.indexOf(part)).filter((at) => at >= 0)
  if (picked.length === 0) return { ...base, other: answer }
  const rest = parts.filter((part) => !labels.includes(part))
  return { ...base, picked, other: rest.length > 0 ? rest.join(', ') : null }
}

/**
 * 动态工具条目是问用户的工具时，题目和回答；别的工具是 null。
 * 还没结果（问着）时每题的回答都是 null；失败了的照结果对不上处理（原文是引擎的报错）
 */
export function askedOf(
  namespace: string | null | undefined,
  tool: string,
  args: unknown,
  content: unknown,
): AskedView | null {
  if (!namespace || ASK_TOOLS[namespace] !== tool) return null
  const questions = questionsOf(args)
  if (!questions) return null
  const texts = textsOf(content)
  if (texts.length === 0)
    return { questions: questions.map((question) => answered(question, null)), raw: null }
  // 每题一行“题头: 回答”，按题的先后
  const lines =
    texts.length === questions.length
      ? texts.map((text, index) => {
          const prefix = `${questions[index]?.header}: `
          return text.startsWith(prefix) ? text.slice(prefix.length) : null
        })
      : []
  if (lines.length === 0 || lines.some((line) => line === null))
    return {
      questions: questions.map((question) => answered(question, null)),
      raw: texts.join('\n'),
    }
  return {
    questions: questions.map((question, index) => {
      const line = lines[index] ?? null
      return answered(question, line === null || line === NO_ANSWER || line === '' ? null : line)
    }),
    raw: null,
  }
}
