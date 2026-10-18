// 对话区“不飘”的验收，做成能自动跑的检查。
// 下面这个函数会被原样变成文本，送进页面里执行，所以它必须自给自足：不能引用函数外面的任何东西。
// 它在页面里真的去滚、去点，逐帧量元素在屏幕上的位置，把量到的数字交回来；合不合格由外面判断。

export interface ScrollProbe {
  /** 贴在底部、回答在增长：内容底边到视口底边的距离变了多少像素（应为 0） */
  followGapSpread: number
  /** 上一项测量期间内容长高了多少像素（证明确实在增长） */
  followGrew: number
  /** 不在底部、回答在增长：视口里的一行在屏幕上挪了多少像素（应为 0） */
  freeSpread: number
  freeGrew: number
  /** 不在底部时经历“回答定稿、活动区自动收起”：同一行挪了多少 */
  finalizeFreeSpread: number
  /** 定稿前后，回答的第一块是不是同一个页面元素（没有整块换掉） */
  finalizeKeptNode: boolean
  /** 贴在底部时经历同样的过程：底边的距离变了多少 */
  finalizeFollowGapSpread: number
  /** 这个过程里活动区确实从展开变成了收起 */
  activityCollapsed: boolean
  /** 活动区和最终回答都在视口里（不在底部）时经历自动收起：回答的第一块挪了多少 */
  answerInView: boolean
  answerSpread: number
  answerCollapsed: boolean
  /** 逐个点开再收起若干个条目：被点的那一行最多挪了多少 */
  toggleMaxShift: number
  toggles: number
  /** 切到别的会话再切回来：原来视口里最靠上的那一行，位置差了多少 */
  restoreShift: number
  /** 不在底部时有没有出现“回到底部”，点了之后有没有回到底部 */
  toBottomShown: boolean
  toBottomWorks: boolean
  /** 贴在底部、待办卡片在一步步更新（中途变长变短）：底边的距离变了多少 */
  todoFollowGapSpread: number
  /** 更新期间卡片出现过几种高度（证明它确实变长变短了） */
  todoHeights: number
  /** 不在底部、待办卡片在眼前更新：视口里最靠上的一行挪了多少 */
  todoInView: boolean
  todoFreeSpread: number
  /** 不在底部、待办卡片在视口下面更新：视口里最靠上的一行挪了多少 */
  todoBelow: boolean
  todoBelowSpread: number
}

export async function scrollProbe(): Promise<ScrollProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  /**
   * 连着取这么久的帧，每帧调一次 each。给了 busy 的话，它还为真的时候不开始计时。
   * 按时间算不按帧数算：刷新率 120 的屏幕上同样的帧数只有一半时间，流出来的字不够多
   */
  const frames = async (ms: number, each: () => void, busy?: () => unknown) => {
    let end = performance.now() + ms
    while (performance.now() < end) {
      await frame()
      each()
      if (busy?.()) end = performance.now() + ms
    }
  }
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
    throw new Error(`等不到：${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string) =>
    document.querySelector<E>(selector)
  const scroller = () => one('.tr-scroll') as HTMLElement
  const content = () => one('.tr') as HTMLElement
  const gap = () =>
    content().getBoundingClientRect().bottom - scroller().getBoundingClientRect().bottom
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
  const live = () => one('.md.live')
  /**
   * 逐帧取样，只取“会被画到屏幕上”的状态。
   * 内容的高度刚变、应用自己的补偿还没执行的那一瞬间，脚本读得到但不会上屏，不能算数：
   * 所以高度变化之后的样本改在尺寸回调里取（这个观察器建得比应用的晚，回调排在它后面）。
   * 对话区重新挂载之后要重新建一个。
   */
  const track = (read: () => number) => {
    const values: number[] = []
    // 高度要带小数比：光标消失这种变化只有一两个像素，取整之后可能看不出来
    const tall = () => content().getBoundingClientRect().height
    let height = tall()
    const observer = new ResizeObserver(() => {
      height = tall()
      values.push(read())
    })
    observer.observe(content())
    return {
      values,
      sample() {
        if (tall() === height) values.push(read())
      },
      stop: () => observer.disconnect(),
    }
  }
  /** 视口里完整露出来的第一行 */
  const firstVisible = () => {
    const top = scroller().getBoundingClientRect().top
    return [...content().querySelectorAll<HTMLElement>('[data-anchor]')].find(
      (element) => element.getBoundingClientRect().top >= top,
    )
  }
  const row = (title: string) =>
    [...document.querySelectorAll<HTMLElement>('.ss-row')].find((element) =>
      element.textContent?.includes(title),
    )
  /** 打开那个会重新流一遍的会话，等它开始出字 */
  const openStreaming = async () => {
    row('聚合面')?.click()
    await until('另一个会话的内容', () => !live() && one('.turn'))
    row('把运行时与')?.click()
    await until('回答开始输出', live)
  }

  // 启动落在新建对话页：先点开那个一打开就在流的会话
  ;(await until('侧栏里那个会流的会话', () => row('把运行时与'))).click()

  // ---- 一、贴在底部，回答在增长 ----
  await until('回答开始输出', live)
  const startHeight = content().offsetHeight
  const follow = track(gap)
  await frames(1500, follow.sample)
  follow.stop()
  const followGapSpread = spread(follow.values)
  const followGrew = content().offsetHeight - startHeight

  // ---- 二、离开底部，回答还在增长 ----
  scroller().scrollTop = -220
  await frame()
  await frame()
  const toBottomShown = Boolean(one('.to-bottom'))
  const held = firstVisible() as HTMLElement
  const firstBlock = live()?.firstElementChild ?? null
  const before = content().offsetHeight
  const free = track(() => held.getBoundingClientRect().top)
  await frames(1500, free.sample)
  const freeSpread = spread(free.values)
  const freeGrew = content().offsetHeight - before

  // ---- 三、不在底部时经历定稿和活动区自动收起 ----
  const wasOpen = Boolean(one('.turn:last-child .act-body'))
  await frames(500, free.sample, live)
  free.stop()
  // free.values 里前面是第二步的样本，合在一起算：从离开底部一直到定稿之后，这一行都不该动
  const finalizeFreeSpread = spread(free.values)
  const finalizeKeptNode = firstBlock?.isConnected === true
  const activityCollapsed = wasOpen && !one('.turn:last-child .act-body')

  // ---- 四、不在底部，但活动区和最终回答都在眼前：收起时回答不跳 ----
  await openStreaming()
  // 重新打开时会回到上一步离开的位置，先回到底部
  one('.to-bottom')?.click()
  await frame()
  // 等回答长出几行再往上滚一点：这样既离开了底部，活动区和回答的开头又都还在视口里
  const answer = (await until('回答的第一块', () => live()?.firstElementChild)) as HTMLElement
  await until(
    '回答长出几行',
    () => scroller().getBoundingClientRect().bottom - answer.getBoundingClientRect().bottom > 80,
  )
  scroller().scrollTop = -40
  await frame()
  await frame()
  const view = scroller().getBoundingClientRect()
  const head = one('.turn:last-child .act-head')?.getBoundingClientRect()
  // 活动区的标题和回答的第一块都要在视口里，这一步量的才是想量的情形
  const answerInView =
    Boolean(one('.turn:last-child .act-body')) &&
    (head?.top ?? -1) >= view.top &&
    answer.getBoundingClientRect().bottom <= view.bottom
  const seen = track(() => answer.getBoundingClientRect().top)
  await frames(500, seen.sample, live)
  seen.stop()
  const answerSpread = spread(seen.values)
  const answerCollapsed = !one('.turn:last-child .act-body')

  // ---- 五、贴在底部时经历同样的过程 ----
  await openStreaming()
  one('.to-bottom')?.click()
  await frame()
  const toBottomWorks = Math.abs(scroller().scrollTop) <= 1 && !one('.to-bottom')
  const bottom = track(gap)
  await frames(500, bottom.sample, live)
  bottom.stop()
  const finalizeFollowGapSpread = spread(bottom.values)

  // ---- 六、点开、收起条目：被点的那一行不动 ----
  let toggleMaxShift = 0
  let toggles = 0
  const click = async (element: HTMLElement | null | undefined) => {
    if (!element) return
    element.scrollIntoView({ block: 'center' })
    await frame()
    await frame()
    const top = element.getBoundingClientRect().top
    element.click()
    for (let index = 0; index < 4; index++) await frame()
    if (!element.isConnected) return
    toggleMaxShift = Math.max(toggleMaxShift, Math.abs(element.getBoundingClientRect().top - top))
    toggles++
  }
  const lastTurn = () => one('.turn:last-child') as HTMLElement
  // 先在底部点（贴底状态），再滚上去点（自由状态）
  for (const position of [0, -160]) {
    scroller().scrollTop = position
    await frame()
    await click(lastTurn().querySelector<HTMLElement>('.act-head'))
    for (const head of lastTurn().querySelectorAll<HTMLElement>('.item-head:not(:disabled)')) {
      await click(head)
      await click(head)
    }
    await click(lastTurn().querySelector<HTMLElement>('.act-head'))
  }

  // ---- 七、切到别的会话再切回来 ----
  scroller().scrollTop = -640
  await frame()
  await frame()
  const mark = firstVisible() as HTMLElement
  const anchor = mark.getAttribute('data-anchor') ?? ''
  const offset = mark.getBoundingClientRect().top - scroller().getBoundingClientRect().top
  row('聚合面')?.click()
  await until(
    '另一个会话的内容',
    () => !content().querySelector(`[data-anchor="${anchor}"]`) && one('.turn'),
  )
  row('把运行时与')?.click()
  const back = await until('切回来之后的内容', () =>
    content().querySelector<HTMLElement>(`[data-anchor="${anchor}"]`),
  )
  await frame()
  await frame()
  const restoreShift = Math.abs(
    back.getBoundingClientRect().top - scroller().getBoundingClientRect().top - offset,
  )

  // ---- 八、待办进度在更新（模拟核心里话里带“待办”就列一份，一步一步做完，中途变长变短） ----
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const say = async (text: string) => {
    const input = await until('输入框', area)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await frame()
  }
  /** 把正在进行的回合停掉：不等它把回答流完 */
  const halt = async () => {
    ;(await until('停止按钮', () => one<HTMLButtonElement>('.send.stop'))).click()
    await until('回合停下来', () => !one('.running-line'))
    await frame()
  }
  const card = () => one('.turn:last-child .todo')
  const count = () => card()?.querySelector('.todo-count')?.textContent ?? ''
  /** 发一句话，等这一轮的待办卡片出来 */
  const listTodos = async (text: string) => {
    const turns = document.querySelectorAll('.turn').length
    await say(text)
    await until(
      '待办卡片',
      () => document.querySelectorAll('.turn').length > turns && count().includes('0/4'),
    )
  }
  /** 一直取样到这份待办全做完，返回这期间卡片出现过几种高度 */
  const watchTodos = async (sample: () => void) => {
    const seen = new Set<number>()
    const end = performance.now() + 15_000
    const look = () => {
      sample()
      seen.add(Math.round(card()?.getBoundingClientRect().height ?? 0))
    }
    while (performance.now() < end && !count().includes('5/5')) {
      await frame()
      look()
    }
    for (let index = 0; index < 6; index++) {
      await frame()
      look()
    }
    return seen.size
  }
  // 这个会话够长，能滚起来。它的回答还在流，先停掉再发
  await halt()
  scroller().scrollTop = 0
  await frame()
  await listTodos('列一份待办')
  const todoFollow = track(gap)
  const todoHeights = await watchTodos(todoFollow.sample)
  todoFollow.stop()
  const todoFollowGapSpread = spread(todoFollow.values)
  await halt()

  // 往上滚一点：卡片的上半截还在眼前
  await listTodos('再列一份待办')
  scroller().scrollTop = -90
  await frame()
  await frame()
  const nearRow = firstVisible() as HTMLElement
  const nearView = scroller().getBoundingClientRect()
  const nearCard = (card() as HTMLElement).getBoundingClientRect()
  const todoInView = nearCard.top >= nearView.top && nearCard.top < nearView.bottom
  const near = track(() => nearRow.getBoundingClientRect().top)
  await watchTodos(near.sample)
  near.stop()
  const todoFreeSpread = spread(near.values)
  await halt()

  // 滚得更远：卡片整个在视口下面
  await listTodos('第三份待办')
  scroller().scrollTop = -700
  await frame()
  await frame()
  const farRow = firstVisible() as HTMLElement
  const todoBelow =
    (card() as HTMLElement).getBoundingClientRect().top >= scroller().getBoundingClientRect().bottom
  const far = track(() => farRow.getBoundingClientRect().top)
  await watchTodos(far.sample)
  far.stop()
  const todoBelowSpread = spread(far.values)

  return {
    todoFollowGapSpread,
    todoHeights,
    todoInView,
    todoFreeSpread,
    todoBelow,
    todoBelowSpread,
    followGapSpread,
    followGrew,
    freeSpread,
    freeGrew,
    finalizeFreeSpread,
    finalizeKeptNode,
    finalizeFollowGapSpread,
    activityCollapsed,
    answerInView,
    answerSpread,
    answerCollapsed,
    toggleMaxShift,
    toggles,
    restoreShift,
    toBottomShown,
    toBottomWorks,
  }
}

/** 量到的数字合不合格。返回不合格的项，空数组就是全过 */
export function judgeScroll(probe: ScrollProbe): string[] {
  const failed: string[] = []
  const within = (name: string, value: number, limit: number) => {
    if (!(value <= limit)) failed.push(`${name}：${value.toFixed(2)} 像素，上限 ${limit}`)
  }
  if (!(probe.followGrew > 40)) failed.push(`贴底测量期间内容没有增长（${probe.followGrew}）`)
  if (!(probe.freeGrew > 40)) failed.push(`离底测量期间内容没有增长（${probe.freeGrew}）`)
  within('贴底时底边抖动', probe.followGapSpread, 0.5)
  within('离开底部后视口内容移动', probe.freeSpread, 1)
  within('定稿和自动收起时视口内容移动（离底）', probe.finalizeFreeSpread, 1)
  within('定稿和自动收起时底边移动（贴底）', probe.finalizeFollowGapSpread, 0.5)
  within('活动区在眼前自动收起时最终回答移动', probe.answerSpread, 1)
  if (!probe.answerInView) failed.push('量“回答不跳”时，活动区和回答没有同时在视口里')
  if (!probe.answerCollapsed) failed.push('量“回答不跳”时，活动区没有自动收起')
  within('点开收起条目时被点的行移动', probe.toggleMaxShift, 1)
  within('切回会话后位置偏差', probe.restoreShift, 1)
  if (!probe.finalizeKeptNode) failed.push('定稿时回答的页面元素被整块换掉了')
  if (!probe.activityCollapsed) failed.push('活动区没有自动收起')
  if (probe.toggles < 6) failed.push(`只成功点了 ${probe.toggles} 次条目`)
  if (!probe.toBottomShown) failed.push('离开底部后没有出现“回到底部”')
  if (!probe.toBottomWorks) failed.push('点“回到底部”没有回到底部')
  within('待办更新时底边移动（贴底）', probe.todoFollowGapSpread, 0.5)
  within('待办在眼前更新时视口内容移动', probe.todoFreeSpread, 1)
  within('待办在视口下面更新时视口内容移动', probe.todoBelowSpread, 1)
  if (probe.todoHeights < 3)
    failed.push(`待办更新期间卡片的高度没怎么变（${probe.todoHeights} 种）`)
  if (!probe.todoInView) failed.push('量“待办在眼前更新”时，卡片不在视口里')
  if (!probe.todoBelow) failed.push('量“待办在视口下面更新”时，卡片没有在视口下面')
  return failed
}
