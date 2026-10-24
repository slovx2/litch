// 对话区两档视图（精简、详细）的验收，只对着模拟核心，接在 client:check:scroll 的“点开收起”后面：
// 那一段留下的“发版前的检查清单”里最后一轮是“长报告”（思考、说明、五条命令、一次读文件、很长的回答），过程收着。
// 从标题栏会话标题后面的菜单切到详细：整段过程、步骤组、思考、每条有详情的条目都展开；视口里正看着的用户消息不动。
// 再切回精简：过程照旧收起；正看着回答时回答不动，正看着展开的步骤（切回去就没了）时退到整段过程那一行、落在视口里。
// 正看着回答时再切到详细：上面的过程往上展开，回答不动。
// 选的档按会话记在界面本地，别的会话还是精简。量位置的办法和点开收起那一段一样：每一帧和内容变高变矮的回调里取样。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface ViewProbe {
  /** 切之前菜单里勾的是精简，本地没记着这个会话 */
  defaultCompact: boolean
  /** 切到详细之后：该展开的都展开了，一共看了几处 */
  verboseAll: boolean
  heads: number
  /** 详细视图里命令的输出框、思考的全文都画出来了 */
  wells: number
  thoughts: number
  /** 点了之后菜单收起 */
  menuClosed: boolean
  /** 记在本地的名单里有这个会话 */
  storedVerbose: boolean
  /** 点下“详细”到画完（再过两帧）用了多久，毫秒 */
  switchMs: number
  /** 切到详细时，视口上方四分之一处这一轮的用户消息挪了多少像素 */
  shiftIn: number
  /** 切回精简时，视口上方四分之一处回答的头一块挪了多少像素 */
  shiftOut: number
  /** 再切到详细时回答的头一块挪了多少像素（上面的过程展开，往上长） */
  shiftAnswer: number
  /** 正看着展开的命令时切回精简：整段过程那一行落在视口里 */
  fallbackSeen: boolean
  /** 切回精简之后：过程收着，没有展开的步骤组 */
  compactAgain: boolean
  storedCleared: boolean
  /** 另开一个会话，菜单里勾的是精简 */
  otherCompact: boolean
}

export async function viewProbe(): Promise<ViewProbe> {
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
    throw new Error(`两档视图：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const scroller = () => one('.tr-scroll') as HTMLElement
  const content = () => one('.tr') as HTMLElement
  const lastTurn = () => all('.turn').at(-1) as HTMLElement
  const stored = () => {
    try {
      return (
        (
          JSON.parse(localStorage.getItem('litch.transcriptView') ?? '{}') as {
            verbose?: string[]
          }
        ).verbose ?? []
      )
    } catch {
      return []
    }
  }
  const title = '发版前的检查清单'
  const row = await until(`侧栏里的“${title}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(title)),
  )
  row.click()
  await until('会话的内容', () => text(one('.crumb')).includes(title) && one('.proc-head'))
  await until('上一轮结束', () => !one('.running-line'), 60_000)

  /** 打开会话菜单，返回勾着的那一档 */
  const openMenu = async () => {
    const button = await until('会话菜单的按钮', () => one<HTMLButtonElement>('.tb-menu > button'))
    if (button.getAttribute('aria-expanded') !== 'true') button.click()
    await until('会话菜单', () => one('.tb-menu [role="menu"]'))
    return one('.tb-menu [aria-checked="true"]')?.getAttribute('data-view') ?? ''
  }
  /** 让这一行的上边缘落在视口上方四分之一处 */
  const place = async (element: HTMLElement) => {
    const view = scroller().getBoundingClientRect()
    scroller().scrollTop += element.getBoundingClientRect().top - view.top - view.height / 4
    await frame()
    await frame()
  }
  /** 从菜单里选一档，量这一行挪了多少（取样到切换后 700 毫秒，盯住的那一阵子都在里面） */
  const pick = async (view: 'compact' | 'verbose', watched: HTMLElement) => {
    await openMenu()
    const option = await until(`菜单里的“${view}”`, () =>
      one<HTMLButtonElement>(`.tb-menu [data-view="${view}"]`),
    )
    const top = watched.getBoundingClientRect().top
    const shifts: number[] = []
    const read = () => {
      if (watched.isConnected) shifts.push(Math.abs(watched.getBoundingClientRect().top - top))
    }
    const observer = new ResizeObserver(read)
    observer.observe(content())
    const since = performance.now()
    option.click()
    await frame()
    await frame()
    const spent = performance.now() - since
    const end = performance.now() + 700
    while (performance.now() < end) {
      await frame()
      read()
    }
    observer.disconnect()
    return { spent, shift: shifts.length > 0 ? Math.max(...shifts) : Number.POSITIVE_INFINITY }
  }

  const before = stored().length
  const defaultCompact = (await openMenu()) === 'compact'
  // 收起菜单再量
  one('.tb-menu > button')?.click()
  await frame()

  // 切到详细：看着这一轮开头的那条用户消息（它下面的过程全展开，往下长）
  const asked = await until('这一轮的用户消息', () =>
    one<HTMLElement>('[data-anchor^="u:"]', lastTurn()),
  )
  await place(asked)
  const toVerbose = await pick('verbose', asked)
  const menuClosed = !one('.tb-menu [role="menu"]')
  const storedVerbose = stored().length === before + 1
  const turn = lastTurn()
  const heads = [
    ...all('.proc-head', turn),
    ...all('.steps-head', turn),
    ...all('.item-head:not(:disabled)', turn),
  ]
  const verboseAll =
    heads.length >= 8 && heads.every((element) => element.getAttribute('aria-expanded') === 'true')
  const wells = all('.item-detail .well', turn).length
  const thoughts = all('.item-detail .think', turn).length

  // 正看着回答时切回精简：回答不动
  const answer = await until('回答的头一块', () =>
    all('.md [data-anchor]', lastTurn()).find((element) => !element.closest('.proc')),
  )
  await place(answer)
  const toCompact = await pick('compact', answer)
  const compactAgain =
    one('.proc-head', lastTurn())?.getAttribute('aria-expanded') === 'false' &&
    all('.steps-body', lastTurn()).length === 0
  const storedCleared = stored().length === before

  // 正看着回答时再切到详细：它上面那段过程展开，回答不动（不能去盯视口里更靠上的过程那一行）
  await place(answer)
  const toAnswer = await pick('verbose', answer)
  // 正看着展开的命令时切回精简：那一行没了，退到整段过程那一行
  const command = await until('展开的命令', () =>
    all('.steps-body .item-head:not(:disabled)', lastTurn()).at(-1),
  )
  await place(command)
  await pick('compact', command)
  const view = scroller().getBoundingClientRect()
  const proc = one('.proc-head', lastTurn())?.getBoundingClientRect()
  const fallbackSeen = proc !== undefined && proc.top >= view.top - 1 && proc.bottom <= view.bottom

  // 别的会话还是精简
  const other = await until('侧栏里别的会话', () =>
    all('.ss-row').find((entry) => !text(entry).includes(title)),
  )
  other.click()
  await until('另一个会话', () => !text(one('.crumb')).includes(title))
  const otherCompact = (await openMenu()) === 'compact'
  one('.tb-menu > button')?.click()
  await frame()

  return {
    defaultCompact,
    verboseAll,
    heads: heads.length,
    wells,
    thoughts,
    menuClosed,
    storedVerbose,
    switchMs: Math.round(toVerbose.spent),
    shiftIn: toVerbose.shift,
    shiftOut: toCompact.shift,
    shiftAnswer: toAnswer.shift,
    fallbackSeen,
    compactAgain,
    storedCleared,
    otherCompact,
  }
}

/** 量到的数字合不合格。返回不合格的项，空数组就是全过 */
export function judgeView(probe: ViewProbe): string[] {
  const failed: string[] = []
  if (!probe.defaultCompact) failed.push('两档视图：会话默认不是精简')
  if (!probe.verboseAll) failed.push(`两档视图：切到详细后没有全展开（看了 ${probe.heads} 处）`)
  if (probe.wells < 5) failed.push(`两档视图：详细视图里命令的输出框只有 ${probe.wells} 个`)
  if (probe.thoughts < 1) failed.push('两档视图：详细视图里思考没有展开')
  if (!probe.menuClosed) failed.push('两档视图：选了之后菜单没有收起')
  if (!probe.storedVerbose) failed.push('两档视图：切到详细后本地没有记下这个会话')
  if (!probe.compactAgain) failed.push('两档视图：切回精简后过程没有收起')
  if (!probe.storedCleared) failed.push('两档视图：切回精简后本地还记着这个会话')
  if (!probe.otherCompact) failed.push('两档视图：别的会话跟着变成了详细')
  if (!(probe.shiftIn <= 1)) {
    failed.push(`两档视图：切到详细时用户消息移动 ${probe.shiftIn.toFixed(2)} 像素，上限 1`)
  }
  if (!(probe.shiftOut <= 1)) {
    failed.push(`两档视图：切回精简时回答移动 ${probe.shiftOut.toFixed(2)} 像素，上限 1`)
  }
  if (!(probe.shiftAnswer <= 1)) {
    failed.push(`两档视图：切到详细时回答移动 ${probe.shiftAnswer.toFixed(2)} 像素，上限 1`)
  }
  if (!probe.fallbackSeen) failed.push('两档视图：看着展开的命令切回精简后，过程那一行不在视口里')
  return failed
}
