// 过程区里跟“回合正在跑”有关的几件事，只对着模拟核心量：
// 一、命令在跑的时候，收着的步骤组那一行写“正在运行”、当前这条命令和“已经跑了多久”
//     （对面不增量给输出时，这是唯一看得出它还活着的东西）；等批准的命令写的是“待审批”，不计时。
//     跑完之后那一行是动作和个数（“运行 1 条命令”）和用时。
// 二、整段过程什么时候自己收成一行：一般的 harness 等最终回答写完（这里是回合停下）；声明了“最终回答一开始就知道”的
//     （模拟核心里的 Codex）在最终回答一开始就收。用户在回合里手动展开过步骤组的，回合结束也不收。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface ActivityProbe {
  /** 一般的 harness（Claude Code）上的会话 */
  plain: {
    /** 命令在跑的时候，步骤组那一行上出现过的“已经跑了多久”（去重，按出现的先后） */
    elapsed: string[]
    /** 跑着的时候那一行写的（动词和当前这条命令） */
    running: string
    /** 命令结束之后那一行写的（汇总和用时） */
    done: string
    /** 最终回答已经在出字、回合还没结束的那一刻，过程是不是还摊着 */
    openWhileAnswering: boolean
    /** 回合结束之后整段过程收成了一行 */
    closedAfter: boolean
  }
  /** 等批准的命令：步骤组那一行写的字、有没有在计时 */
  waiting: { label: string; timed: boolean }
  /** 回合进行中手动展开过步骤组：回合结束之后过程还摊着 */
  touched: { openAfter: boolean }
  /** 声明了“最终回答一开始就知道”的 harness（Codex）上的会话 */
  early: {
    /** 最终回答已经在出字、回合还没结束的那一刻，整段过程已经收起来了 */
    closedWhileAnswering: boolean
  }
}

export async function activityProbe(): Promise<ActivityProbe> {
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
      await frame()
    }
    throw new Error(`过程区：等不到${what}`)
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
  /** 要看的看完了就把回合停掉：模拟的回答一个字一个字出，等它写完要十几秒 */
  const stop = async () => {
    const button = await until('停止按钮', () => one<HTMLButtonElement>('.send.stop'), 10_000)
    button.click()
    await idle()
  }

  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && area())
    await idle()
  }
  const say = async (words: string) => {
    const input = await until('输入框', area)
    write(input, words)
    await frame()
    press(input, 'Enter')
  }
  /** 最后一个回合 */
  const lastTurn = () => all('.turn').at(-1) ?? null
  /** 最后一个回合里的过程（第一段） */
  const proc = () => one('.proc', lastTurn() ?? undefined)
  /** 过程摊着：没收成一行（回合进行中没有那一行，过程本来就摊着） */
  const procOpen = () => Boolean(one('.proc-body', proc() ?? undefined))
  /** 过程收成了一行 */
  const procClosed = () =>
    one('.proc-head', proc() ?? undefined)?.getAttribute('aria-expanded') === 'false' && !procOpen()
  /** 最后一个回合里那个步骤组的汇总行 */
  const group = () => one('.steps-head', lastTurn() ?? undefined)
  /** 最终回答已经在出字：过程后面有了带字的东西（不算“回合进行中”那一行和回合的尾巴） */
  const answering = () => {
    const block = proc()
    if (!block) return false
    for (let next = block.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.matches('.running-line, .turn-foot')) continue
      if (text(next)) return true
    }
    return false
  }
  /** 发一句“跑一会儿”，一路看到回合结束。touch：命令在跑的时候点开步骤组 */
  const runAWhile = async (touch = false) => {
    const before = all('.turn').length
    await say('跑一会儿')
    await until('新的回合', () => all('.turn').length > before)
    await until('那条命令', () => text(one('.now', group() ?? undefined)).includes('npm test'))
    if (touch) group()?.click()
    const elapsed: string[] = []
    let state = ''
    // 命令跑着的这两秒多：每一帧看一眼那一行写的是什么。每次都重新找那一行，不拿着旧的节点不放
    const deadline = performance.now() + 20_000
    for (;;) {
      const head = group()
      if (!head || !one('.st.run', head)) break
      const spent = text(one('[data-elapsed]', head))
      if (spent && !elapsed.includes(spent)) elapsed.push(spent)
      state = `${text(one('.sum', head))} ${text(one('.now', head))}`
      if (performance.now() > deadline) {
        throw new Error(`过程区：那条命令一直没结束（那一行写着“${text(head)}”）`)
      }
      await frame()
    }
    const head = group()
    const done = `${text(one('.sum', head ?? undefined))} ${text(one('.meta', head ?? undefined))}`
    // 最终回答开始出字、回合还在跑的那一刻
    await until('最终回答开始出字', () => answering() || !running(), 60_000)
    const openWhileAnswering = running() ? procOpen() : null
    await stop()
    await frame()
    await frame()
    return {
      elapsed,
      running: state,
      done,
      openWhileAnswering,
      closedAfter: procClosed(),
      openAfter: procOpen(),
    }
  }

  // ---- 一、一般的 harness ----
  await open('远程设备安装指引')
  const plain = await runAWhile()
  if (plain.openWhileAnswering === null) {
    throw new Error('过程区：没赶上最终回答出字的那一段（回合已经结束了）')
  }

  // ---- 等批准的命令 ----
  await say('要一次审批')
  const card = await until('审批卡片', () => one<HTMLElement>('.req'), 60_000)
  await frame()
  await frame()
  const held = all('.steps-head', lastTurn() ?? undefined).find((entry) =>
    one('[data-state="waiting"]', entry),
  )
  const waiting = {
    label: text(one('[data-state="waiting"]', held ?? undefined)),
    timed: Boolean(one('[data-elapsed]', lastTurn() ?? undefined)),
  }
  // 不答它，直接把回合停掉：挂着的请求跟着作废
  if (!card.isConnected) throw new Error('过程区：审批卡片自己没了')
  await stop()

  // ---- 手动展开过步骤组的回合 ----
  const touched = await runAWhile(true)

  // ---- 二、最终回答一开始就知道的 harness ----
  await open('核对构建机上的 codex 配置')
  const early = await runAWhile()
  if (early.openWhileAnswering === null) {
    throw new Error('过程区：没赶上最终回答出字的那一段（回合已经结束了）')
  }
  await sleep(0)

  return {
    plain: {
      elapsed: plain.elapsed,
      running: plain.running,
      done: plain.done,
      openWhileAnswering: plain.openWhileAnswering,
      closedAfter: plain.closedAfter,
    },
    waiting,
    touched: { openAfter: touched.openAfter },
    early: { closedWhileAnswering: early.openWhileAnswering === false },
  }
}

export function judgeActivity(probe: ActivityProbe): string[] {
  const failed: string[] = []
  const { plain, waiting, touched, early } = probe
  // 两秒多的命令：至少看得到“1 秒”，而且都是整秒（末位不带小数，免得一直跳）
  if (plain.elapsed.length === 0) {
    failed.push('命令在跑的时候，步骤组那一行上没有“已经跑了多久”')
  } else if (!plain.elapsed.every((entry) => /^\d+ 秒$/.test(entry))) {
    failed.push(`“已经跑了多久”不是整秒：${plain.elapsed.join('、')}`)
  }
  if (plain.running !== '正在运行 npm test') {
    failed.push(`命令在跑的时候步骤组那一行写的是“${plain.running}”`)
  }
  if (!/^运行 1 条命令 2\.\d 秒$/.test(plain.done)) {
    failed.push(`命令结束之后步骤组那一行写的不是汇总和用时：${plain.done}`)
  }
  if (!plain.openWhileAnswering) {
    failed.push('一般的 harness：最终回答还没写完，过程就收起来了')
  }
  if (!plain.closedAfter) failed.push('回合结束之后整段过程没有收成一行')
  if (waiting.label !== '待审批') failed.push(`等批准的命令那一行写的是“${waiting.label}”`)
  if (waiting.timed) failed.push('等批准的命令在计时：等人的时间不该算成它跑了多久')
  if (!touched.openAfter) failed.push('回合里手动展开过步骤组，回合结束时过程还是自己收起来了')
  if (!early.closedWhileAnswering) {
    failed.push('声明了“最终回答一开始就知道”的 harness：最终回答已经在出字，过程还摊着')
  }
  return failed
}
