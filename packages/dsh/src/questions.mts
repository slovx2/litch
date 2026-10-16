import { sleep } from '../../shared/src/util.mjs'
import type { WaterfallOutcome } from './remote.mjs'
import type { DshServer, LiveThread } from './server.mjs'

// 打断回合时作废还在等回答的请求用的理由（DshServer.interrupt）。提问因此作废时不替用户答，见 ask。
export const TURN_STOPPED = '回合已停止'

const hasOptions = (question: any): boolean =>
  Array.isArray(question?.options) && question.options.length > 0

// 协议里的题号。客户端的回答是按题号组织的一个对象，所以一次请求里的题号得各不相同、能当对象的键：
// dsh 的题号是模型起的，它默认的提问工具不查重（只有限时版查），空的、__proto__（客户端往普通对象上
// 赋这个键，答案就没了）也会原样过来。规整的（非空、这次调用里头一回出现、不是 __proto__）照用 dsh 的；
// 别的另起一个：q 加这道题的序号（从 1 数），和别的题号撞了再加 -2、-3。只看题目本身，
// 同一组题算几遍都一样（工具条目里的题和发给客户端的题各算一遍，要对得上，见 Projection.claimQuestion）。
// 交回 dsh 的答案用的还是 dsh 自己的题号，按题的先后对（dshAnswers、answerContent）。
function protocolIds(list: any[]): string[] {
  const taken = new Set<string>()
  const own = list.map((question) => {
    const id = question?.id
    if (typeof id !== 'string' || id === '' || id === '__proto__' || taken.has(id)) return null
    taken.add(id)
    return id
  })
  return own.map((id, index) => {
    if (id !== null) return id
    let made = `q${index + 1}`
    for (let n = 2; taken.has(made); n += 1) made = `q${index + 1}-${n}`
    taken.add(made)
    return made
  })
}

// dsh 的题（ask_user_question 工具的参数，和 user-questions/request 里的题是同一个样子）转成协议里的题。
// 题号见 protocolIds。dsh 的每道题都可以不选选项、自己写一段（答案里的 custom），所以都标 isOther。
// 协议的题上没有多选的标记，多选题到客户端和单选题一个样子，和 Claude 入口一样；没有选项的是问答题
//（options 为 null）。计划评审的题带着计划正文（detail），接在题面后面。
export function userQuestions(list: unknown): any[] {
  const raw = Array.isArray(list) ? list : []
  const ids = protocolIds(raw)
  return raw.map((question: any, index) => ({
    id: ids[index] as string,
    header: String(question?.header ?? `Question ${index + 1}`).slice(0, 12),
    question: [question?.question, question?.detail]
      .filter((part) => typeof part === 'string' && part !== '')
      .join('\n\n'),
    isOther: true,
    isSecret: false,
    options: Array.isArray(question?.options)
      ? question.options.map((option: any) => ({
          label: String(option?.label ?? ''),
          description: String(option?.description ?? ''),
        }))
      : null,
  }))
}

// 提问工具的结果（dsh 交给模型的那段 JSON：{answers: [{id, selected, custom?}]}）转成条目里的内容：
// 每道题一行“题头: 答案”，选的几项和自己写的连在一起，没答的是 (no answer)，和 Claude 入口一样。
// 认不出来的结果原样放一行。raw 是 dsh 的原题（工具参数里的 questions）：结果里的题号是 dsh 的，
// 按它找这道题的答案；题号重复的按先后一一对上。
export function answerContent(questions: any[], raw: unknown, output: string): any[] {
  let answers: any[] | null = null
  try {
    const value = JSON.parse(output)
    if (Array.isArray(value?.answers)) answers = value.answers
  } catch {}
  if (!answers) return [{ type: 'inputText', text: output }]
  const own = Array.isArray(raw) ? raw : []
  const used = new Set<number>()
  return questions.map((question, index) => {
    const id = own[index]?.id ?? question.id
    const at = answers.findIndex((entry, n) => !used.has(n) && entry?.id === id)
    if (at >= 0) used.add(at)
    const answer = at >= 0 ? answers[at] : undefined
    const given = [
      ...(Array.isArray(answer?.selected) ? answer.selected : []),
      ...(typeof answer?.custom === 'string' && answer.custom ? [answer.custom] : []),
    ]
    return { type: 'inputText', text: `${question.header}: ${given.join(', ') || '(no answer)'}` }
  })
}

// 客户端的回答（按协议题号，每道题一组字）转成 dsh 的答案：和某个选项的字一样的是选了那一项，
// 别的是自己写的（几段用换行连起来）；一个字都没有的是跳过，selected 为空、不带 custom，dsh 认的就是这样。
// 回答里没有这道题也是跳过：官方桌面端只交回答了的题（{题号: {answers: [选项的 label 或写的字]}}），
// Litch 每道题都交、跳过的是空数组，两种一样对待。交回 dsh 的题号是它自己的（raw），按题的先后。
function dshAnswers(raw: any[], questions: any[], replies: Map<string, any>): { answers: any[] } {
  return {
    answers: questions.map((question, index) => {
      const slot = replies.get(question.id)
      const given: string[] = (Array.isArray(slot?.answers) ? slot.answers : []).filter(
        (entry: unknown) => typeof entry === 'string' && entry.trim() !== '',
      )
      const labels = new Set((question.options ?? []).map((option: any) => option.label))
      const custom = given.filter((entry) => !labels.has(entry)).join('\n')
      const id = raw[index]?.id
      return {
        id: typeof id === 'string' ? id : question.id,
        selected: given.filter((entry) => labels.has(entry)),
        ...(custom ? { custom } : {}),
      }
    }),
  }
}

// 一张提问卡片里的题要么都有选项、要么都没有选项：按原来的先后把连着的同类题分成一组，每组发一次请求。
// 官方桌面端（26.1007.x）的提问卡片在一张卡片里从“有选项、能自己写”的题翻到“没有选项”的题时
//（往前、往回都算），会把前一题的选择清掉，交回时那道题就没有了：翻题有退场动画，旧题退场时还挂着，
// 卡片给新题聚焦输入框，焦点落在旧题“自己写”的输入框上，那个框获得焦点时会取消本题的选择。
// 上游的模型出的题一定带选项，Claude 入口也是，碰不到；dsh 的题可以没有选项。
function cards(questions: any[]): any[][] {
  const out: any[][] = []
  for (const question of questions) {
    const last = out.at(-1)
    if (last && hasOptions(last[0]) === hasOptions(question)) last.push(question)
    else out.push([question])
  }
  return out
}

// 等 dsh 撤回这次事件，最多等 ms 毫秒。
function withdrawn(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// dsh 要问用户时（模型调了 ask_user_question，或者计划模式下的计划评审）发来 user-questions/request 瀑布事件：
// 转成 item/tool/requestUserInput 发给会话的全部订阅连接，先答的生效，答案交回 dsh，由它写成工具结果给模型。
// 有选项和没有选项的题混在一起时拆成几次请求、一次一组（见 cards），挨个问完再一起交回；都挂在同一个工具条目上。
// 问不成的（没有连着的客户端、拿着请求的连接都断了、客户端回了错误）交回 dsh（next）：它去问别的应答方
//（比如它自己的网页端），都没有就让模型拿到“没有人应答”的报错，回合接着走。
// 回合被打断的不替用户答：dsh 取消回合时自己撤回这次提问，模型那边记的是“用户回答之前就中止了”。
// 这时交回 next 的话，取消到达之前模型会先拿到“没有人应答”、多走一步。
export async function ask(
  server: DshServer,
  live: LiveThread,
  request: any,
  signal: AbortSignal,
): Promise<WaterfallOutcome> {
  const { projection } = live
  const threadId = projection.thread.id
  const raw: any[] = Array.isArray(request.questions) ? request.questions : []
  const questions = userQuestions(raw)
  // 提问与落盘事件走同一条连接的两条流，等对应的工具条目先到（同 approvals.mts）。dsh 默认的提问方式
  // 不带调用号，按题号认还没答的那一次提问调用；计划评审的题带着 exit_plan_mode 那次调用的调用号。
  const callId = request.wait?.callId ?? request.questions?.[0]?.intent?.callId
  const find = () =>
    typeof callId === 'string'
      ? projection.call(callId)?.item
      : projection.claimQuestion(questions.map((question) => question.id))
  let item = find()
  for (let waited = 0; waited < 2000 && !item && !signal.aborted; waited += 50) {
    await sleep(50)
    item = find()
  }
  let replies: Map<string, any> | null = null
  let stopped = false
  try {
    // 等回答的这段时间（拆成几次的从头到尾）线程标着在等用户（Projection.waiting）
    replies = await projection.waiting(
      'question',
      (method, params) => server.notify(threadId, method, params),
      async () => {
        const got = new Map<string, any>()
        for (const card of cards(questions)) {
          const reply = await server.call(
            threadId,
            'item/tool/requestUserInput',
            { ...(item ? { itemId: item.id } : {}), isBlocking: true, questions: card },
            signal,
          )
          if (!reply || typeof reply !== 'object') return null
          // 只收这一组的题号：别的键（包括 __proto__）不碰
          const given = reply.answers
          for (const question of card)
            if (given && typeof given === 'object' && Object.hasOwn(given, question.id))
              got.set(question.id, given[question.id])
        }
        return got
      },
    )
  } catch (error) {
    stopped = error instanceof Error && error.message === TURN_STOPPED
  }
  if (replies) return { kind: 'result', value: dshAnswers(raw, questions, replies) }
  // dsh 取消回合会撤回这次提问；取消没成（等过了适配器自己收尾回合的那 10 秒）才交回。
  if (stopped) await withdrawn(signal, 15000)
  return { kind: 'next' }
}
