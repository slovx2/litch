// 模型边干活边问的题（codex 的 request_user_input_async）的验收：对话里的问题卡片。只对着模拟核心量
// （话里带“边做边问”时模拟核心先出一条带题的助手消息，接着跑八秒命令再回话，见 mock-core.mts）。
// 卡片露在过程外面、回合结束不跟着收；选一个、写一个之后发出去，答复插进还在跑的回合（不排队、不另起回合），
// 气泡里画成“题目 → 回答”，卡片变成已答；不答等回合过去、再说一句别的之后，卡片变成只读的“没有回答”。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface AskProbe {
  /** 卡片出来了，等你回答；有两题，第一题两个选项 */
  shown: boolean
  /** 卡片不在过程（.proc）里面 */
  outside: boolean
  /** 发出去之后：卡片成了已答，第一题是选的那个、第二题是写的那句 */
  answered: string[]
  /** 答复插进了同一个回合：回合数没变、回合还在跑、队列是空的 */
  steered: boolean
  /** 答复的气泡里是“回答了问题”加题目和回答，不露标签和 JSON */
  bubble: boolean
  /** 回合结束之后卡片还露在外面 */
  keptAfterTurn: boolean
  /** 第二次问了不答：回合结束、再说一句别的之后，卡片是“没有回答”，没有输入框和发送按钮 */
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
  const lastCard = () => all('.ask').at(-1)

  const title = '发版前的检查清单'
  const row = await until(`侧栏里的“${title}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(title)),
  )
  row.click()
  await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
  await idle()

  // ---- 一、问了就答：选第二个选项，第二题自己写 ----
  await say('边做边问：跑一下测试')
  const card = await until('问题卡片', () => {
    const found = lastCard()
    return found?.dataset.state === 'open' ? found : null
  })
  const shown = all('.ask-q', card).length === 2 && all('.ask-q .opt', card).length === 2
  const outside = card.closest('.proc') === null
  const turns = all('.turn').length
  all('.opt', card)[1]?.click()
  await frame()
  const field = all('input', card)[1] as HTMLInputElement | undefined
  if (field) writeTo(field, '#litch-ci')
  await frame()
  one<HTMLButtonElement>('.btn.primary', card)?.click()
  await until('卡片变成已答', () => card.dataset.state === 'answered', 10_000).catch(() => null)
  const answered = all('.ask-answer', card).map((entry) => text(entry))
  const steered = all('.turn').length === turns && running() && all('.tray-row').length === 0
  const reply = all('.turn').at(-1)?.querySelector('.ask-reply')
  const bubble =
    Boolean(reply) &&
    text(reply).includes('#litch-ci') &&
    !text(reply).includes('send_user_message_question_reply')
  await idle()
  await sleep(300)
  const keptAfterTurn = lastCard() === card && card.closest('.proc') === null

  // ---- 二、问了不答：回合结束、再说一句别的，卡片过去了 ----
  await say('边做边问：再跑一遍')
  const second = await until('第二张问题卡片', () => {
    const found = lastCard()
    return found !== card && found?.dataset.state === 'open' ? found : null
  })
  await idle()
  await say('先这样')
  await until('第二张卡片过去', () => second.dataset.state === 'closed', 10_000).catch(() => null)
  const closed =
    second.dataset.state === 'closed' && !one('input', second) && !one('.btn.primary', second)
  await idle()
  return { shown, outside, answered, steered, bubble, keptAfterTurn, closed }
}

export function judgeAsk(probe: AskProbe | null): string[] {
  if (!probe) return []
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`问题卡片：${what}`)
  }
  check(probe.shown, '带题的消息没有画成两题的问题卡片')
  check(probe.outside, '问题卡片收进了过程里')
  check(
    probe.answered.join('｜') === '照常全跑｜#litch-ci',
    `发出去之后卡片上的回答不对：${probe.answered.join('｜')}`,
  )
  check(probe.steered, '答复没有插进正在跑的回合（排了队或者另起了回合）')
  check(probe.bubble, '答复的气泡没有画成题目和回答')
  check(probe.keptAfterTurn, '回合结束之后问题卡片不见了或者收起来了')
  check(probe.closed, '不答、回合过去之后卡片还能答')
  return failed
}
