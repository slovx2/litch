// 文件面板的验收，对着模拟核心里的示例文件树（packages/core/src/mock/sample-files.mts）。
// 这一段量侧面板的开合和文件树：懒加载、每层只问一次、三万个条目的目录展开和滚动时的帧间隔、说明行、
// 符号链接、隐藏文件、键盘、刷新。分几段送进页面里执行，编排在 probe-files-run.mts。
// 页面里用的那套手在 probe-files-kit.mts；和别的验收一样，下面的函数不能引用函数外面的东西。
import type { FilesKit } from './probe-files-kit.mjs'

export interface ManySeen {
  /** 点下去到三万行到了、画出来，一共多久（毫秒） */
  ms: number
  gaps: number[]
  /** 树里一共多少行（摊平之后） */
  rows: number
  /** 页面上真的画了多少行 */
  dom: number
  /** 这一层向设备问过几次 */
  asked: number
  /** 前几行的名字：目录在前 */
  head: string[]
}

export interface ScrollSeen {
  gaps: number[]
  /** 三万个条目里的最后一项，滚到它那里画的是谁 */
  tail: string
  /** 滚到中间某一行，那个位置上画的是谁；按“目录在前、文件按名字排”算它该是谁 */
  mid: string
  midWanted: string
  /** 滚动的全程里，页面上最多同时画了多少行 */
  domMax: number
  /** 滚的过程里有没有哪一帧窗口里是空的（看得见的地方一行都没画） */
  blank: number
}

export interface TreeSeen {
  /** 一开始面板是收着的 */
  startsClosed: boolean
  /** 点标题栏的按钮打开：面板出来了，按钮是按下的样子，看的是“文件”标签，焦点在树上 */
  opened: boolean
  pressed: boolean
  tab: string
  tabLabel: string
  focusInTree: boolean
  /** 面板挂在哪台设备的哪个项目、哪个根 */
  place: string
  root: string
  /** 根下面有什么，每项写成“种类:名字” */
  rootRows: string[]
  /** 根这一层问过几次；这时候一共问过哪些目录（相对路径） */
  rootAsked: number
  askedAtStart: string[]
  many: ManySeen
  scroll: ScrollSeen
  /** 收起再马上展开：还是只问过一次，行数也没变 */
  reexpand: { asked: number; rows: number; ms: number }
  /** 收起三万行的目录之后，树里剩多少行 */
  afterCollapse: number
  /** 空目录、列不了的目录各自的说明；列不了的那个有没有“重试” */
  emptyNote: string
  lockedNote: string
  lockedRetry: boolean
  /** 指向目录的符号链接：当目录显示，展开得了 */
  linkKind: string
  linkChildren: string[]
  /** 打开“显示隐藏文件”多出来的名字；关上之后又没了 */
  hiddenShown: string[]
  hiddenPressed: boolean
  hiddenGone: boolean
  /** 键盘：Home、往下、往右展开、往右进去、往左回上一级、往左收起，每一步之后选中的是谁 */
  keys: string[]
  /** 刷新之前、之后根这一层各问过几次 */
  refresh: [number, number]
  /** 没展开过的目录没有被问过 */
  untouched: string[]
}

export async function mockTree(session: string): Promise<TreeSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame, sleep } = kit
  await until('侧栏里有会话', () => one('.ss-row'), 40_000)
  await kit.openSession(session)
  const startsClosed = !kit.sideOpen()
  kit.toggle()
  await until('面板打开', () => kit.sideOpen())
  const pressed = one('.tb-side')?.getAttribute('aria-pressed') === 'true'
  const tabButton = await until('标签栏', () => one<HTMLElement>('.side-tab[aria-selected="true"]'))
  await until('树取到了根', () => kit.rows().length > 0)
  const focusInTree = await kit.seen(() => document.activeElement === kit.tree(), 3000)
  const panel = kit.side()
  const place = `${panel?.dataset.device}/${panel?.dataset.workspace}`
  const rootRows = kit.rows().map((row) => `${row.kind}:${row.name}`)

  const relative = (path: string) => {
    // 核心记的是设备上的完整路径（~ 已经换成了主目录）：按结尾认
    const known = ['fixtures/many', 'fixtures/empty', 'fixtures/locked', 'fixtures', 'packages']
    for (const entry of known) if (path.endsWith(`/${entry}`)) return entry
    return path
  }
  const askedOf = (lists: Record<string, number>, name: string) =>
    Object.entries(lists).find(([path]) => relative(path) === name)?.[1] ?? 0
  const first = await kit.check()
  const rootPath = Object.keys(first.lists).sort((a, b) => a.length - b.length)[0] ?? ''
  const rootAsked = first.lists[rootPath] ?? 0
  const askedAtStart = Object.keys(first.lists).map((path) =>
    path === rootPath ? '' : path.slice(rootPath.length + 1),
  )

  // ---------- 三万个条目的目录 ----------
  await kit.expand('fixtures')
  await kit.rowShown('fixtures/many')
  const before = kit.rowCount()
  const grown = await kit.frames(async () => {
    const started = performance.now()
    kit.click((await kit.rowShown('fixtures/many')) as HTMLElement)
    await until('三万行到了', () => kit.rowCount() - before >= 30_000, 60_000)
    await frame()
    return performance.now() - started
  })
  const manyIndex = kit.rows().find((row) => row.path === 'fixtures/many')?.index ?? -1
  const many: ManySeen = {
    ms: grown.value,
    gaps: grown.gaps,
    rows: kit.rowCount(),
    dom: all('.ft-row, .ft-note').length,
    asked: askedOf((await kit.check()).lists, 'fixtures/many'),
    head: kit
      .rows()
      .filter((row) => row.index > manyIndex)
      .slice(0, 3)
      .map((row) => row.name),
  }

  // ---------- 在三万行里滚 ----------
  const treeElement = kit.tree() as HTMLElement
  const total = kit.rowCount()
  let domMax = 0
  let blank = 0
  const rolled = await kit.frames(async () => {
    // 一帧挪一大段，一直挪到底：每一帧看一眼画了多少行、看得见的地方是不是空的
    const bottom = treeElement.scrollHeight - treeElement.clientHeight
    const steps = 90
    for (let step = 1; step <= steps; step++) {
      treeElement.scrollTop = Math.round((bottom * step) / steps)
      await frame()
      const drawn = all('.ft-row, .ft-note')
      domMax = Math.max(domMax, drawn.length)
      const box = treeElement.getBoundingClientRect()
      const visible = drawn.some((row) => {
        const at = row.getBoundingClientRect()
        return at.bottom > box.top && at.top < box.bottom
      })
      if (!visible) blank++
    }
  })
  await until('滚到底了', () => Number(treeElement.dataset.last) === total)
  // many 里面的最后一项：它下面先是 40 个目录，再是 29960 个文件
  const tailIndex = manyIndex + 30_000
  await kit.scrollTree(tailIndex - 3)
  const tail =
    (await until('最后那一项', () => kit.rows().find((row) => row.index === tailIndex))).name ?? ''
  // 中间挑一行：many 下面先是 40 个目录，再是文件，第 12345 个文件该是 item-12345.txt
  const midIndex = manyIndex + 1 + 40 + 12_345
  await kit.scrollTree(midIndex)
  const mid = await until('中间那一行', () => kit.rows().find((row) => row.index === midIndex))
  const scroll: ScrollSeen = {
    gaps: rolled.gaps,
    tail,
    mid: mid.name,
    midWanted: 'item-12345.txt',
    domMax,
    blank,
  }

  // ---------- 收起再展开：短时间里不再问 ----------
  await kit.scrollTree(manyIndex)
  await kit.collapse('fixtures/many')
  const afterCollapse = kit.rowCount()
  const again = await kit.frames(async () => {
    const started = performance.now()
    kit.click((await kit.rowShown('fixtures/many')) as HTMLElement)
    await until('又是三万行', () => kit.rowCount() - before >= 30_000, 60_000)
    return performance.now() - started
  })
  const reexpand = {
    asked: askedOf((await kit.check()).lists, 'fixtures/many'),
    rows: kit.rowCount(),
    ms: again.value,
  }
  await kit.collapse('fixtures/many')

  // ---------- 说明行、符号链接 ----------
  const noteUnder = async (relativePath: string, kind: string) =>
    until(`${relativePath} 下面的说明`, () =>
      all('.ft-note').find(
        (entry) =>
          entry.dataset.kind === kind && entry.dataset.path?.endsWith(`/${relativePath}`) === true,
      ),
    )
  kit.click(await kit.rowShown('fixtures/empty'))
  const emptyNote = text(await noteUnder('fixtures/empty', 'empty'))
  kit.click(await kit.rowShown('fixtures/locked'))
  const locked = await noteUnder('fixtures/locked', 'failed')
  const lockedNote = text(one('.ell', locked))
  const lockedRetry = Boolean(one('button', locked))
  await kit.collapse('fixtures')
  const linkKind = kit.rows().find((row) => row.path === 'link-to-docs')?.kind ?? ''
  await kit.expand('link-to-docs')
  await until('链接里面的东西', () =>
    kit.rows().some((row) => row.path.startsWith('link-to-docs/')),
  )
  const linkChildren = kit
    .rows()
    .filter((row) => row.path.startsWith('link-to-docs/'))
    .map((row) => row.name)
  await kit.collapse('link-to-docs')

  // ---------- 隐藏文件 ----------
  const plain = new Set(kit.rows().map((row) => row.name))
  const hiddenButton = one<HTMLButtonElement>('[data-tool="hidden"]') as HTMLButtonElement
  hiddenButton.click()
  await until('隐藏的出来了', () => kit.rows().some((row) => row.name.startsWith('.')))
  const hiddenShown = kit
    .rows()
    .map((row) => row.name)
    .filter((name) => !plain.has(name))
  const hiddenPressed = hiddenButton.getAttribute('aria-pressed') === 'true'
  hiddenButton.click()
  const hiddenGone = await kit.seen(() => !kit.rows().some((row) => row.name.startsWith('.')))

  // ---------- 键盘 ----------
  const keys: string[] = []
  const selected = () => kit.rows().find((row) => row.selected)
  const stroke = async (key: string, settled: () => unknown) => {
    kit.press(treeElement, key)
    await kit.seen(settled, 5000)
    await frame()
    const now = selected()
    keys.push(
      `${key}→${now?.path ?? '（没有）'}${now?.kind === 'dir' && now.expanded ? '（开）' : ''}`,
    )
  }
  treeElement.focus()
  await stroke('Home', () => selected()?.index === 0)
  const top = selected()?.path ?? ''
  await stroke('ArrowDown', () => selected()?.index === 1)
  await stroke('ArrowUp', () => selected()?.index === 0)
  // 展开之后等它里面的东西到了再往里走
  await stroke('ArrowRight', () => kit.rows().some((row) => row.path.startsWith(`${top}/`)))
  await stroke('ArrowRight', () => selected()?.index === 1)
  await stroke('ArrowLeft', () => selected()?.index === 0)
  await stroke('ArrowLeft', () => selected()?.expanded === false)
  await stroke('End', () => selected()?.index === kit.rowCount() - 1)
  keys.push(`顶上那一行是 ${top}`)

  // ---------- 刷新：不走缓存，根这一层再问一次 ----------
  const beforeRefresh = (await kit.check()).lists[rootPath] ?? 0
  one<HTMLButtonElement>('[data-tool="refresh"]')?.click()
  let afterRefresh = beforeRefresh
  for (let tries = 0; tries < 60 && afterRefresh === beforeRefresh; tries++) {
    await sleep(50)
    afterRefresh = (await kit.check()).lists[rootPath] ?? 0
  }
  const last = await kit.check()
  const untouched = ['packages'].filter((name) => askedOf(last.lists, name) === 0)

  return {
    startsClosed,
    opened: kit.sideOpen(),
    pressed,
    tab: tabButton.dataset.tab ?? '',
    tabLabel: text(tabButton),
    focusInTree,
    place,
    root: kit.root(),
    rootRows,
    rootAsked,
    askedAtStart,
    many,
    scroll,
    reexpand,
    afterCollapse,
    emptyNote,
    lockedNote,
    lockedRetry,
    linkKind,
    linkChildren,
    hiddenShown,
    hiddenPressed,
    hiddenGone,
    keys,
    refresh: [beforeRefresh, afterRefresh],
    untouched,
  }
}
