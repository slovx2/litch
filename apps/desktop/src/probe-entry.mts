// 对着真实入口的验收：真实的会话记录画出来之后，滚动和点开条目还稳不稳、够不够顺。
// 和 probe-scroll.mts 一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 会话是 scripts/client-fixture-seed.mjs 造的，这里按它们的名字去点。

export interface EntryProbe {
  /** 一个回合里有多少个步骤条目被画出来（造了 120 次命令，加上别的） */
  manyRows: number
  /** 展开这一百多行之后来回滚动：帧间隔的中位数、95 分位、最大值（毫秒） */
  frameMedian: number
  frameP95: number
  frameMax: number
  /** 贴在底部时点开、收起条目：被点的那一行最多挪了多少 */
  toggleMaxShift: number
  toggles: number
  /** 文件改动点开后有没有画出差异的行 */
  diffLines: number
  /** 长对话：回合数，以及切走再切回来之后位置差了多少 */
  longTurns: number
  restoreShift: number
  /** 不属于任何项目的会话有没有出现在“无项目”下面 */
  looseListed: boolean
}

export async function entryProbe(): Promise<EntryProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<number>((done) => requestAnimationFrame(done))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 20_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}`)
  }
  const one = (selector: string) => document.querySelector<HTMLElement>(selector)
  const scroller = () => one('.tr-scroll') as HTMLElement
  const content = () => one('.tr') as HTMLElement
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      [...document.querySelectorAll<HTMLElement>('.ss-row')].find((element) =>
        element.textContent?.includes(title),
      ),
    )
    row.click()
    // 标题栏换成这个会话，而且内容到了
    await until(
      `“${title}”的内容`,
      () => one('.crumb')?.textContent?.includes(title) && one('.turn'),
    )
    await frame()
  }

  // ---- 一、带文件改动的会话：贴在底部时点开、收起 ----
  await open('给首页加一个状态条')
  let toggleMaxShift = 0
  let toggles = 0
  const click = async (element: HTMLElement | null | undefined) => {
    if (!element) return
    const top = element.getBoundingClientRect().top
    element.click()
    for (let index = 0; index < 4; index++) await frame()
    if (!element.isConnected) return
    toggleMaxShift = Math.max(toggleMaxShift, Math.abs(element.getBoundingClientRect().top - top))
    toggles++
  }
  const lastTurn = () => one('.turn:last-child') as HTMLElement
  await click(lastTurn().querySelector<HTMLElement>('.proc-head'))
  for (const group of lastTurn().querySelectorAll<HTMLElement>('.steps-head')) await click(group)
  const change = lastTurn().querySelector<HTMLElement>('.item-head:not(:disabled)')
  await click(change)
  const diffLines = lastTurn().querySelectorAll('.dl').length
  await click(change)
  await click(lastTurn().querySelector<HTMLElement>('.proc-head'))

  // ---- 二、一个回合里一百多次工具调用：展开后来回滚 ----
  await open('逐个检查一百多个文件')
  one('.proc-head[aria-expanded="false"]')?.click()
  await until('点开的过程', () => one('.steps-head'))
  for (const group of document.querySelectorAll<HTMLElement>(
    '.steps-head[aria-expanded="false"]',
  )) {
    group.click()
  }
  await until('展开的步骤条目', () => document.querySelectorAll('.item').length > 100)
  const manyRows = document.querySelectorAll('.item').length
  const range = scroller().scrollHeight - scroller().clientHeight
  const stamps: number[] = []
  for (let index = 0; index < 180; index++) {
    // 上去再下来，每帧走一段
    const phase = index < 90 ? index / 90 : (180 - index) / 90
    scroller().scrollTop = -range * phase
    stamps.push(await frame())
  }
  const intervals = stamps.slice(1).map((stamp, index) => stamp - (stamps[index] ?? stamp))
  const sorted = [...intervals].sort((a, b) => a - b)
  const at = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0

  // ---- 三、长对话：切走再切回来 ----
  await open('连接层的重连与对账')
  const longTurns = document.querySelectorAll('.turn').length
  scroller().scrollTop = -2400
  await frame()
  await frame()
  const top = scroller().getBoundingClientRect().top
  const mark = [...content().querySelectorAll<HTMLElement>('[data-anchor]')].find(
    (element) => element.getBoundingClientRect().top >= top,
  ) as HTMLElement
  const anchor = mark.getAttribute('data-anchor') ?? ''
  const offset = mark.getBoundingClientRect().top - top
  await open('给首页加一个状态条')
  await open('连接层的重连与对账')
  const back = await until('切回来之后的那一行', () =>
    content().querySelector<HTMLElement>(`[data-anchor="${anchor}"]`),
  )
  await frame()
  const restoreShift = Math.abs(
    back.getBoundingClientRect().top - scroller().getBoundingClientRect().top - offset,
  )

  const looseLabel = [...document.querySelectorAll('.sec-label')].find((element) =>
    element.textContent?.includes('无项目'),
  )
  return {
    manyRows,
    frameMedian: at(0.5),
    frameP95: at(0.95),
    frameMax: sorted.at(-1) ?? 0,
    toggleMaxShift,
    toggles,
    diffLines,
    longTurns,
    restoreShift,
    looseListed: Boolean(looseLabel?.parentElement?.querySelector('.ss-row')),
  }
}

/** slow：机器本身就慢（CI 的虚拟机没有显卡），帧间隔的标准放宽到三倍，只拦明显的退步 */
export function judgeEntry(probe: EntryProbe, slow: boolean): string[] {
  const failed: string[] = []
  if (probe.manyRows < 120) failed.push(`步骤条目只画出 ${probe.manyRows} 个`)
  // 一帧 16.7 毫秒。95 分位不超过两帧，最慢的一帧不超过 100 毫秒
  const scale = slow ? 3 : 1
  if (!(probe.frameP95 <= 34 * scale))
    failed.push(`滚动时帧间隔的 95 分位是 ${probe.frameP95.toFixed(1)} 毫秒`)
  if (!(probe.frameMax <= 100 * scale))
    failed.push(`滚动时最慢的一帧是 ${probe.frameMax.toFixed(1)} 毫秒`)
  if (!(probe.toggleMaxShift <= 1)) {
    failed.push(`点开收起条目时被点的行挪了 ${probe.toggleMaxShift.toFixed(2)} 像素`)
  }
  if (probe.toggles < 4) failed.push(`只成功点了 ${probe.toggles} 次条目`)
  if (probe.diffLines < 2) failed.push('文件改动点开后没有画出差异')
  if (probe.longTurns !== 24) failed.push(`长对话应该有 24 个回合，画出了 ${probe.longTurns} 个`)
  if (!(probe.restoreShift <= 1))
    failed.push(`切回会话后位置差了 ${probe.restoreShift.toFixed(2)} 像素`)
  if (!probe.looseListed) failed.push('不属于任何项目的会话没有出现在“无项目”下面')
  return failed
}
