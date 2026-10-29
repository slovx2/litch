// 异步问题从输入框上方的待答区作答。只检查作答、插话与待答生命周期，不绑定历史卡片/气泡的布局。
// 模拟核心收到“边做边问”时出两题，接着跑八秒命令；回合结束不能清掉未答题。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface AskProbe {
  shown: boolean
  outside: boolean
  answered: string[]
  steered: boolean
  /** 历史里能读到答案，没有协议标签；不要求单独的答复气泡。 */
  bubble: boolean
  remainingAfterFirst: boolean
  shiftEnterKept: boolean
  imeKept: boolean
  keptAfterTurn: boolean
  /** 用户另发普通消息视为答复，待答入口收起。 */
  closed: boolean
}

export async function askProbe(real: boolean): Promise<AskProbe | null> {
  if (real) return null
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`问题卡片：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const writeTo = (target: HTMLTextAreaElement | HTMLInputElement, words: string) => {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const say = async (words: string) => {
    const input = await until('输入框', area)
    input.focus()
    writeTo(input, words)
    await frame()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await until(`“${words}”发出去`, () =>
      all('.umsg-text').some((entry) => text(entry).includes(words)),
    )
  }
  const idle = () => until('这一轮结束', () => !running() && area(), 60_000)
  const pending = () => all('[data-pending-question]')
  const question = (id: string) => pending().find((entry) => entry.dataset.pendingQuestion === id)

  const title = '发版前的检查清单'
  const row = await until(`侧栏里的“${title}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(title)),
  )
  row.click()
  await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
  await idle()

  await say('边做边问：跑一下测试')
  await until('两道待答题', () => pending().length === 2)
  const [first, second] = pending()
  if (!first || !second) throw new Error('缺少待答题')
  const firstId = first.dataset.pendingQuestion ?? ''
  const secondId = second.dataset.pendingQuestion ?? ''
  const choice = all('button', first).find((button) => text(button) === '照常全跑')
  const shown = Boolean(choice) && Boolean(one('textarea', second))
  const outside = pending().every((entry) => entry.closest('.proc') === null)
  const turns = all('.turn').length
  choice?.click()
  await frame()
  one<HTMLButtonElement>('button[type="submit"]', first)?.click()
  await until('第一题已答', () => !question(firstId))
  const remainingAfterFirst = Boolean(question(secondId)) && pending().length === 1
  const field = one<HTMLTextAreaElement>('textarea', question(secondId))
  if (!field) throw new Error('第二题没有自由答复输入框')
  field.focus()
  writeTo(field, '#litch-ci')
  await frame()
  const shift = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  field.dispatchEvent(shift)
  await frame()
  const shiftEnterKept = !shift.defaultPrevented && Boolean(question(secondId))
  const ime = new KeyboardEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    bubbles: true,
    cancelable: true,
  })
  field.dispatchEvent(ime)
  await frame()
  const imeKept = !ime.defaultPrevented && Boolean(question(secondId))
  field.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  )
  await until('第二题已答', () => !question(secondId))
  const transcript = text(all('.turn').at(-1))
  const answered = ['照常全跑', '#litch-ci'].filter((answer) => transcript.includes(answer))
  const steered = all('.turn').length === turns && running() && all('.tray-row').length === 0
  const bubble =
    transcript.includes('#litch-ci') && !transcript.includes('send_user_message_question_reply')
  await idle()

  await say('边做边问：再跑一遍')
  await until('新一轮两道待答题', () => pending().length === 2)
  const ids = pending().map((entry) => entry.dataset.pendingQuestion ?? '')
  await idle()
  const keptAfterTurn = ids.every((id) => Boolean(question(id)))
  await say('先这样')
  await until('用户发话后待答入口收起', () => ids.every((id) => !question(id)))
  const closed = ids.every((id) => !question(id))
  await idle()
  return {
    shown,
    outside,
    answered,
    steered,
    bubble,
    remainingAfterFirst,
    shiftEnterKept,
    imeKept,
    keptAfterTurn,
    closed,
  }
}

export function judgeAsk(probe: AskProbe | null): string[] {
  if (!probe) return []
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`问题卡片：${what}`)
  }
  check(probe.shown, '输入框上方没有两道可回答的问题')
  check(probe.outside, '问题卡片收进了过程里')
  check(
    probe.answered.join('｜') === '照常全跑｜#litch-ci',
    `发出去之后卡片上的回答不对：${probe.answered.join('｜')}`,
  )
  check(probe.steered, '答复没有插进正在跑的回合（排了队或者另起了回合）')
  check(probe.bubble, '历史没有可读答案，或露出了协议标签')
  check(probe.remainingAfterFirst, '回答第一题错误清掉了第二题')
  check(probe.shiftEnterKept, 'Shift+Enter 被拦截或错误提交答案')
  check(probe.imeKept, 'IME 组字回车错误提交答案')
  check(probe.keptAfterTurn, '回合结束清掉了尚未回答的问题')
  check(probe.closed, '用户另发消息后仍残留此前的待答入口')
  return failed
}
