// 回合结束后在过程区里点开、收起的验收，只对着模拟核心（接在 client:check:scroll 后面）：
// 发“长报告”，模拟核心回一轮带思考、说明、五条命令、一次读文件的过程，和一段很长的回答（标题、两张表、列表）。
// 回合结束、过程自动收起之后，在两种位置上逐个点：整段过程那一行、步骤组的标题、思考那一行、步骤组里的一条命令，
// 每个点开再收起。量被点的那一行在屏幕上挪了多少（应为 0）。
// 两种位置：滚到最上面（收起时滚动范围变小，浏览器会先把滚动位置夹回范围里，最容易补多），
// 和被点的那一行在视口上方四分之一处。两套皮肤各走一遍。
// 整个函数会被转成文字放进页面里执行，所以用到的工具都写在函数里面。

export interface FoldProbe {
  /** 回合走到了结束，最终回答比视口高、里面有表格 */
  ready: boolean
  answerTall: boolean
  answerTables: number
  /** 被点的那一行最多挪了多少像素，和是哪一下 */
  maxShift: number
  worst: string
  /** 成功点了几次（点完状态真的变了） */
  toggles: number
  /** 滚到最上面时收起，滚动范围确实变小到夹住了滚动位置的次数（证明量到了这种情形） */
  clamped: number
}

export async function foldProbe(): Promise<FoldProbe> {
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
    throw new Error(`点开收起：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const scroller = () => one('.tr-scroll') as HTMLElement
  const content = () => one('.tr') as HTMLElement
  const lastTurn = () => all('.turn').at(-1) as HTMLElement
  const look = (window as { __litchLook?: { set(patch: { skin: string }): void } }).__litchLook
  if (!look) throw new Error('界面上没有给验收换外观的口子（window.__litchLook）')

  const title = '发版前的检查清单'
  const row = await until(`侧栏里的“${title}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(title)),
  )
  row.click()
  await until('会话的内容', () => text(one('.crumb')).includes(title) && area())
  await until('上一轮结束', () => !running() && area(), 60_000)
  const input = await until('输入框', area)
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    input,
    '写一份长报告',
  )
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await frame()
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  await until('这一轮开始', running, 10_000)
  const ready = await until('这一轮结束', () => !running() && area(), 120_000).then(
    () => true,
    () => false,
  )
  const answer = all('.md', lastTurn()).at(-1)
  const answerTall =
    (answer?.getBoundingClientRect().height ?? 0) > scroller().getBoundingClientRect().height
  const answerTables = answer ? all('table', answer).length : 0

  let maxShift = 0
  let worst = ''
  let toggles = 0
  let clamped = 0
  /** 滚到要的位置：top 是滚到最上面，否则是让这一行的上边缘落在视口上方四分之一处 */
  const place = async (element: HTMLElement, where: 'top' | 'upper') => {
    const view = scroller().getBoundingClientRect()
    if (where === 'top') scroller().scrollTop = scroller().clientHeight - scroller().scrollHeight
    else scroller().scrollTop += element.getBoundingClientRect().top - view.top - view.height / 4
    await frame()
    await frame()
  }
  /** 点一下，量这一行挪了多少。样本取在每一帧和内容变高变矮的回调里（回调建得比应用的晚，排在补偿后面） */
  const click = async (
    name: string,
    find: () => HTMLElement | null | undefined,
    where: 'top' | 'upper',
  ) => {
    const element = find()
    if (!element) return
    await place(element, where)
    const scroll = scroller()
    const top = element.getBoundingClientRect().top
    const expanded = element.getAttribute('aria-expanded')
    const range = scroll.scrollHeight - scroll.clientHeight
    const atTop = Math.abs(scroll.scrollTop + range) < 1
    const shifts: number[] = []
    const read = () => shifts.push(Math.abs(element.getBoundingClientRect().top - top))
    const observer = new ResizeObserver(read)
    observer.observe(content())
    element.click()
    for (let index = 0; index < 8; index++) {
      await frame()
      read()
    }
    observer.disconnect()
    if (!element.isConnected || element.getAttribute('aria-expanded') === expanded) return
    toggles++
    // 收起之后滚动范围比原来的滚动位置还小：浏览器夹过
    if (atTop && scroll.scrollHeight - scroll.clientHeight < range - 1) clamped++
    const shift = Math.max(...shifts)
    if (shift > maxShift) {
      maxShift = shift
      worst = `${name}（${where}）`
    }
  }
  const proc = () => one('.proc-head', lastTurn())
  const group = () => all('.steps-head', lastTurn()).at(-1)
  const thought = () => one('.item[data-tone="quiet"] > .item-head', lastTurn())
  const command = () => one('.steps-body .item-head:not(:disabled)', lastTurn())
  for (const skin of ['retro', 'human']) {
    look.set({ skin })
    await Promise.race([document.fonts.ready, sleep(5000)])
    await frame()
    await frame()
    for (const where of ['top', 'upper'] as const) {
      // 过程自动收起了：点开，再点开步骤组；接着思考、命令各点开收起；最后收起步骤组、整段过程
      await click('过程那一行', proc, where)
      await click('步骤组', group, where)
      await click('思考', thought, where)
      await click('思考', thought, where)
      await click('命令', command, where)
      await click('命令', command, where)
      await click('步骤组', group, where)
      await click('过程那一行', proc, where)
    }
  }
  look.set({ skin: 'retro' })
  return { ready, answerTall, answerTables, maxShift, worst, toggles, clamped }
}

/** 量到的数字合不合格。返回不合格的项，空数组就是全过 */
export function judgeFold(probe: FoldProbe): string[] {
  const failed: string[] = []
  if (!probe.ready) failed.push('点开收起：“长报告”那一轮没有走到结束')
  if (!probe.answerTall) failed.push('点开收起：最终回答没有比视口高')
  if (probe.answerTables < 2) failed.push(`点开收起：最终回答里的表格不够（${probe.answerTables}）`)
  // 两套皮肤 × 两种位置 × 每处 8 下
  if (probe.toggles < 32) failed.push(`点开收起：只成功点了 ${probe.toggles} 次`)
  if (probe.clamped < 4)
    failed.push(`点开收起：滚到最上面收起时滚动位置被夹住的只有 ${probe.clamped} 次`)
  if (!(probe.maxShift <= 1)) {
    failed.push(
      `点开收起时被点的行移动：${probe.maxShift.toFixed(2)} 像素（${probe.worst}），上限 1`,
    )
  }
  return failed
}
