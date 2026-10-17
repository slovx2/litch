import type { LiveThread, OpencodeServer } from './server.mjs'

// OpenCode 的提问（question 工具，事件 question.asked）转成 item/tool/requestUserInput。
// OpenCode 的题：{question, header, options[{label, description}], multiple?, custom?}，没有题号，
// 回答是按题的先后排的一组组字（选中的选项的 label，或者自己写的字）：POST /question/{id}/reply {answers}。

/** 打断回合时作废还在等回答的请求用的理由（OpencodeServer.interrupt） */
export const TURN_STOPPED = '回合已停止'

const hasOptions = (question: any): boolean =>
  Array.isArray(question?.options) && question.options.length > 0

// 协议里的题。题号按先后起（q1、q2……）：OpenCode 的题没有题号，客户端的回答按题号组织。
// custom 不是 false 的题都能自己写一段（OpenCode 默认就能），标 isOther。协议的题上没有多选的标记，
// 多选题到客户端和单选题一个样子，和 Claude、dsh 入口一样；没有选项的是问答题（options 为 null）。
export function userQuestions(list: unknown): any[] {
  const raw = Array.isArray(list) ? list : []
  return raw.map((question: any, index) => ({
    id: `q${index + 1}`,
    header: String(question?.header ?? `Question ${index + 1}`),
    question: String(question?.question ?? ''),
    isOther: question?.custom !== false || !hasOptions(question),
    isSecret: false,
    options: hasOptions(question)
      ? question.options.map((option: any) => ({
          label: String(option?.label ?? ''),
          description: String(option?.description ?? ''),
        }))
      : null,
  }))
}

// 提问工具的结果转成条目里的内容：每道题一行“题头: 答案”，没答的是 (no answer)，和 Claude、dsh 入口一样。
// answers 是工具 metadata 里的原样（按题的先后，每题一组字）；没有的话把交给模型的那段原文放一行。
export function answerContent(questions: any[], answers: unknown, output: string): any[] {
  if (!Array.isArray(answers)) return [{ type: 'inputText', text: output }]
  return questions.map((question, index) => {
    const given = Array.isArray(answers[index]) ? (answers[index] as unknown[]) : []
    const text = given.filter((entry) => typeof entry === 'string' && entry).join(', ')
    return { type: 'inputText', text: `${question.header}: ${text || '(no answer)'}` }
  })
}

// 一张提问卡片里的题要么都有选项、要么都没有选项：按原来的先后把连着的同类题分成一组，每组发一次请求。
// 官方桌面端（26.1007.x）的提问卡片从“有选项、能自己写”的题翻到“没有选项”的题时会把前一题的选择清掉
//（dsh 入口查出来的，见 packages/dsh/src/questions.mts 的 cards），OpenCode 的题也可以没有选项。
function cards(questions: any[]): any[][] {
  const out: any[][] = []
  for (const question of questions) {
    const last = out.at(-1)
    if (last && hasOptions(last[0]) === hasOptions(question)) last.push(question)
    else out.push([question])
  }
  return out
}

/**
 * 问用户：发给会话的全部订阅连接，先答的生效。返回交回 OpenCode 的答案（按题的先后，每题一组字）；
 * 问不成（没有连着的客户端、拿着请求的连接都断了、客户端回了错误、回合被打断）返回 null，由调用方拒绝这次提问。
 * 官方桌面端只交回答了的题（{题号: {answers: [...]}}），Litch 每道题都交、跳过的是空数组，两种一样对待。
 */
export async function ask(
  server: OpencodeServer,
  live: LiveThread,
  request: any,
  signal: AbortSignal,
): Promise<string[][] | null> {
  const { projection } = live
  const threadId = projection.thread.id
  const raw: any[] = Array.isArray(request.questions) ? request.questions : []
  const questions = userQuestions(raw)
  // 条目还没画时用部件号（见 projection.itemIdOfCall）
  const itemId = projection.itemIdOfCall(request.tool?.callID) ?? String(request.id)
  try {
    return await projection.waiting(
      'question',
      (method, params) => server.notify(threadId, method, params),
      async () => {
        const got = new Map<string, any>()
        for (const card of cards(questions)) {
          const reply = await server.call(
            threadId,
            'item/tool/requestUserInput',
            { itemId, isBlocking: true, questions: card },
            signal,
          )
          if (!reply || typeof reply !== 'object') return null
          const given = reply.answers
          for (const question of card)
            if (given && typeof given === 'object' && Object.hasOwn(given, question.id))
              got.set(question.id, given[question.id])
        }
        return questions.map((question) => {
          const slot = got.get(question.id)
          return (Array.isArray(slot?.answers) ? slot.answers : []).filter(
            (entry: unknown): entry is string => typeof entry === 'string' && entry.trim() !== '',
          )
        })
      },
    )
  } catch {
    return null
  }
}
