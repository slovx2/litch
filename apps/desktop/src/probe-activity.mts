// 活动区里两件跟“回合正在跑”有关的事，只对着模拟核心量：
// 一、命令在跑的时候那一行上有“已经跑了多久”（对面不增量给输出时，这是唯一看得出它还活着的东西）；
//     等批准的命令写的是“待审批”，不计时。
// 二、活动块什么时候自己收起来：一般的 harness 等最终回答写完；声明了“最终回答一开始就知道”的
//     （模拟核心里的 Codex）在最终回答一开始就收。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface ActivityProbe {
  /** 一般的 harness（Claude Code）上的会话 */
  plain: {
    /** 命令在跑的时候，右边那几个字里出现过的“已经跑了多久”（去重，按出现的先后） */
    elapsed: string[]
    /** 跑着的时候右边的状态字 */
    running: string
    /** 命令结束之后右边的字（时长和结果） */
    done: string
    /** 最终回答已经在出字、回合还没结束的那一刻，活动块是不是还开着 */
    openWhileAnswering: boolean
    /** 回合结束之后活动块收起来了 */
    closedAfter: boolean
  }
  /** 等批准的命令：右边写的字、有没有在计时 */
  waiting: { label: string; timed: boolean }
  /** 声明了“最终回答一开始就知道”的 harness（Codex）上的会话 */
  early: {
    /** 最终回答已经在出字、回合还没结束的那一刻，活动块已经收起来了 */
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
    throw new Error(`活动区：等不到${what}`)
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
  /** 最后一个回合里的活动块，和它是不是开着 */
  const block = () => one('.act', lastTurn() ?? undefined)
  const blockOpen = () => one('.act-head', block() ?? undefined)?.getAttribute('aria-expanded')
  /** 最后一个回合里那条命令右边的几个字 */
  const meta = (command: string) => {
    const row = all('.item-head', lastTurn() ?? undefined).find((entry) =>
      text(one('.tgt', entry)).includes(command),
    )
    return row ? one('.meta', row) : null
  }
  /** 最终回答已经在出字：活动块后面有了带字的东西（不算“回合进行中”那一行和回合的尾巴） */
  const answering = () => {
    const act = block()
    if (!act) return false
    for (let next = act.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.matches('.running-line, .turn-foot')) continue
      if (text(next)) return true
    }
    return false
  }
  /** 发一句“跑一会儿”，一路看到回合结束 */
  const runAWhile = async () => {
    const before = all('.turn').length
    await say('跑一会儿')
    await until('新的回合', () => all('.turn').length > before)
    await until('那条命令', () => meta('npm test'))
    const elapsed: string[] = []
    let state = ''
    // 命令跑着的这两秒多：每一帧看一眼右边写的是什么。每次都重新找那一行，不拿着旧的节点不放
    const deadline = performance.now() + 20_000
    for (;;) {
      const now = meta('npm test')
      const head = now?.closest('.item-head')
      if (!head || !one('.st.run', head)) break
      const spent = text(one('[data-elapsed]', now ?? undefined))
      if (spent && !elapsed.includes(spent)) elapsed.push(spent)
      state = text(now?.lastElementChild) || state
      if (performance.now() > deadline) {
        throw new Error(`活动区：那条命令一直没结束（右边写着“${text(now)}”）`)
      }
      await frame()
    }
    const done = all('span', meta('npm test') ?? undefined)
      .map(text)
      .join(' ')
    // 最终回答开始出字、回合还在跑的那一刻
    await until('最终回答开始出字', () => answering() || !running(), 60_000)
    const openWhileAnswering = running() ? blockOpen() === 'true' : null
    await stop()
    await frame()
    await frame()
    return {
      elapsed,
      running: state,
      done,
      openWhileAnswering,
      closedAfter: blockOpen() === 'false',
    }
  }

  // ---- 一、一般的 harness ----
  await open('远程设备安装指引')
  const plain = await runAWhile()
  if (plain.openWhileAnswering === null) {
    throw new Error('活动区：没赶上最终回答出字的那一段（回合已经结束了）')
  }

  // ---- 等批准的命令 ----
  await say('要一次审批')
  const card = await until('审批卡片', () => one<HTMLElement>('.req'), 60_000)
  await frame()
  await frame()
  const held = all('.item-head', lastTurn() ?? undefined)
    .map((entry) => one('.meta', entry))
    .find((entry) => entry && one('[data-state="waiting"]', entry))
  const waiting = {
    label: text(one('[data-state="waiting"]', held ?? undefined)),
    timed: Boolean(one('[data-elapsed]', lastTurn() ?? undefined)),
  }
  // 不答它，直接把回合停掉：挂着的请求跟着作废
  if (!card.isConnected) throw new Error('活动区：审批卡片自己没了')
  await stop()

  // ---- 二、最终回答一开始就知道的 harness ----
  await open('核对构建机上的 codex 配置')
  const early = await runAWhile()
  if (early.openWhileAnswering === null) {
    throw new Error('活动区：没赶上最终回答出字的那一段（回合已经结束了）')
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
    early: { closedWhileAnswering: early.openWhileAnswering === false },
  }
}

export function judgeActivity(probe: ActivityProbe): string[] {
  const failed: string[] = []
  const { plain, waiting, early } = probe
  // 两秒多的命令：至少看得到“1 秒”，而且都是整秒（末位不带小数，免得一直跳）
  if (plain.elapsed.length === 0) {
    failed.push('命令在跑的时候，那一行上没有“已经跑了多久”')
  } else if (!plain.elapsed.every((entry) => /^\d+ 秒$/.test(entry))) {
    failed.push(`“已经跑了多久”不是整秒：${plain.elapsed.join('、')}`)
  }
  if (plain.running !== '运行中') failed.push(`命令在跑的时候右边写的是“${plain.running}”`)
  if (!/2\.\d 秒 通过$/.test(plain.done)) {
    failed.push(`命令结束之后右边写的不是时长和结果：${plain.done}`)
  }
  if (!plain.openWhileAnswering) {
    failed.push('一般的 harness：最终回答还没写完，活动块就收起来了')
  }
  if (!plain.closedAfter) failed.push('回合结束之后活动块没有收起来')
  if (waiting.label !== '待审批') failed.push(`等批准的命令右边写的是“${waiting.label}”`)
  if (waiting.timed) failed.push('等批准的命令在计时：等人的时间不该算成它跑了多久')
  if (!early.closedWhileAnswering) {
    failed.push('声明了“最终回答一开始就知道”的 harness：最终回答已经在出字，活动块还开着')
  }
  return failed
}
