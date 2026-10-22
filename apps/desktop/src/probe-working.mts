// 回合末尾那一行“{harness} 正在工作”什么时候隐去，只对着模拟核心量。
// 发一句“忙一阵”：几条很快跑完的命令、读一个文件、一段思考、一段说明，步与步之间停一会儿，最后出回答。
// 这一格回合在跑时一直在 DOM 里，隐去只是带上 data-hidden（Transcript.tsx）。用 MutationObserver 记下它每次
// 隐去、显出的时刻和那一刻回合里在发生什么（有没有正文在出字、有几步在跑），再每一帧看一眼用时。
// 要的是：命令、工具、思考来来去去时它不隐去；正文出字时隐去；出完字的空档里很快又出来；用时一直往上走。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface WorkingToggle {
  /** 从发出那句话算起的毫秒数 */
  at: number
  hidden: boolean
  /** 那一刻在跑的步骤（步骤组汇总行、组里的条目上的运行记号）个数 */
  steps: number
}

export interface WorkingProbe {
  /** 每一次隐去、显出，按先后 */
  toggles: WorkingToggle[]
  /** 回合里一共来过几步（命令、工具、思考）：没来过就什么都没量到 */
  stepsSeen: number
  /** 每段正文（说明、最终回答）在页面上出现头几个字的时刻，从发出那句话算起 */
  liveStarts: number[]
  /** 有正文在出字、这一行却显着的帧数 */
  shownWhileLive: number
  /** 一段正文出完之后到这一行显出来的毫秒数（回合里每个这样的空档一个数） */
  backAfterLive: number[]
  /** 回合在跑时，这一行上出现过的用时（去重，按出现的先后） */
  elapsed: string[]
}

export async function workingProbe(): Promise<WorkingProbe> {
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
      await frame()
    }
    throw new Error(`正在工作那一行：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 120_000)

  const title = '远程设备安装指引'
  const row = await until(`侧栏里的“${title}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(title)),
  )
  row.click()
  await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && area())
  await idle()

  const before = all('.turn').length
  const input = await until('输入框', area)
  write(input, '忙一阵')
  await frame()
  press(input, 'Enter')
  const sent = performance.now()
  const turn = await until('新的回合', () =>
    all('.turn').length > before ? all('.turn').at(-1) : null,
  )
  const slot = await until('末尾那一格', () => one('.running-line.slot', turn))

  /** 此刻回合里在发生什么。还没出字的正文（只有光标）不算在出字，那还是在等 */
  const live = () => all('.md.live', turn).some((block) => text(block) !== '')
  const steps = () => all('.st.run', turn).filter((mark) => !mark.closest('.running-line')).length
  const hidden = () => {
    const now = one('.running-line.slot', turn)
    return !now || now.hasAttribute('data-hidden')
  }

  const toggles: WorkingToggle[] = []
  let last = hidden()
  const note = () => {
    const now = hidden()
    if (now === last) return
    last = now
    toggles.push({ at: Math.round(performance.now() - sent), hidden: now, steps: steps() })
  }
  // React 提交之后这一格的属性一变就记下（同一刻的别的 DOM 也已经提交了）
  const watcher = new MutationObserver(note)
  watcher.observe(turn, { attributes: true, attributeFilter: ['data-hidden'], subtree: true })
  void slot

  let stepsSeen = 0
  const liveStarts: number[] = []
  let shownWhileLive = 0
  const backAfterLive: number[] = []
  const elapsed: string[] = []
  let wasLive = false
  let liveEnded: number | null = null
  let lastSteps = 0
  const deadline = performance.now() + 90_000
  while (running()) {
    if (performance.now() > deadline) throw new Error('正在工作那一行：回合一直没结束')
    const nowLive = live()
    const nowSteps = steps()
    if (nowSteps > lastSteps) stepsSeen += nowSteps - lastSteps
    lastSteps = nowSteps
    if (nowLive && !wasLive) liveStarts.push(Math.round(performance.now() - sent))
    if (!nowLive && wasLive) liveEnded = performance.now()
    wasLive = nowLive
    const shown = !hidden()
    if (nowLive && shown) shownWhileLive++
    if (shown && liveEnded !== null) {
      backAfterLive.push(Math.round(performance.now() - liveEnded))
      liveEnded = null
    }
    const spent = text(one('.running-line .running-time', turn))
    if (spent && !elapsed.includes(spent)) elapsed.push(spent)
    await frame()
  }
  watcher.disconnect()
  await idle()
  return { toggles, stepsSeen, liveStarts, shownWhileLive, backAfterLive, elapsed }
}

export function judgeWorking(probe: WorkingProbe): string[] {
  const failed: string[] = []
  const { toggles, stepsSeen, liveStarts, shownWhileLive, backAfterLive, elapsed } = probe
  if (stepsSeen < 4) failed.push(`正在工作那一行：回合里只看到 ${stepsSeen} 步在跑，场景没演全`)
  if (liveStarts.length < 2) {
    failed.push(`正在工作那一行：正文只出过 ${liveStarts.length} 段，场景没演全`)
  }
  // 隐去只该因为正文在出字。开头那一下（还没显出过）不算
  const firstShown = toggles.findIndex((entry) => !entry.hidden)
  if (firstShown < 0) failed.push('正在工作那一行：回合在跑时一次都没显出来')
  // 这一格跟着核心的数据隐去，正文的字画出来要晚一两帧：隐去前后 300 毫秒内有正文出字就算是为它让开
  const forText = (entry: WorkingToggle) =>
    liveStarts.some((start) => start >= entry.at - 100 && start <= entry.at + 300)
  const stray = toggles.filter(
    (entry, index) => index > firstShown && entry.hidden && !forText(entry),
  )
  if (stray.length > 0) {
    failed.push(
      `正在工作那一行：没有正文在出字时隐去了 ${stray.length} 次（${stray
        .map((entry) => `${entry.at} 毫秒、${entry.steps} 步在跑`)
        .join('；')}）`,
    )
  }
  const hides = toggles.filter((entry) => entry.hidden && forText(entry)).length
  if (hides < 1) failed.push('正在工作那一行：正文出字时没有隐去')
  if (shownWhileLive > 1) failed.push(`正在工作那一行：正文出字时还显着（${shownWhileLive} 帧）`)
  // 说明出完、下一步还没来的那个空档里要显出来，而且不拖
  if (backAfterLive.length === 0) failed.push('正在工作那一行：正文出完之后的空档里没有再显出来')
  else if (backAfterLive.some((ms) => ms > 1000)) {
    failed.push(`正在工作那一行：正文出完之后过了太久才显出来（${backAfterLive.join('、')} 毫秒）`)
  }
  const seconds = elapsed.map((entry) => Number(/^(\d+) 秒$/.exec(entry)?.[1] ?? Number.NaN))
  if (seconds.length < 3 || seconds.some((n) => Number.isNaN(n))) {
    failed.push(`正在工作那一行：用时没有一直走（${elapsed.join('、')}）`)
  } else if (seconds.some((n, index) => index > 0 && n < (seconds[index - 1] ?? 0))) {
    failed.push(`正在工作那一行：用时往回跳了（${elapsed.join('、')}）`)
  }
  return failed
}
