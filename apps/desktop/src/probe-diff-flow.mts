// 差异面板的验收，对着模拟核心（接 probe-diff.mts）：代理改完文件回合结束后自己跟上、面板收着的时候不取、
// 从对话里去差异面板、行内批注跟着下一条消息发出去、几百个文件时还用得动、太大的文件只给摘要、
// 看不了 git 的几种地方、窄的时候改成上下摆和合并、六套外观下加的删的行看不看得出来。
import type { DiffKit } from './probe-diff-kit.mjs'
import type { FilesKit, Frames } from './probe-files-kit.mjs'

export interface TurnSeen {
  /** 说了“改文件”：回合还在跑的时候面板是哪一版、列表里有没有新文件（应该还没有） */
  duringTurn: { sameVersion: boolean; listed: boolean }
  /** 回合结束之后：面板自己换了一版，新文件在列表里 */
  afterTurn: { moved: boolean; listed: string[] }
  /** 这一回合里核心为差异重新取了几次概况 */
  refreshes: number
  /** 对话里那条“改了文件”上的入口：点了之后差异里选中的是哪个文件 */
  fromTranscript: string
  /** 面板收着的时候又改了一次：这期间重新取了几次（应该是 0）；打开之后列表里代理写的那几个文件 */
  closed: { refreshes: number; listed: string[] }
  /**
   * 那一次改的里面有一个六百行的新文件：对话里它那一处不展开，说了什么；
   * 点它上面“在差异面板里看”之后，差异里选中的是哪个文件
   */
  tooLong: { note: string; picked: string }
  /** 把其中一个文件删掉之后再从对话里点过去：它已经没有改动了，出的提示说什么 */
  goneToast: string
}

export async function mockTurn(): Promise<TurnSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until } = kit
  const turnDone = async (count: number) => {
    await until('新的回合出来', () => all('.turn').length > count, 20_000)
    await until('回合结束', () => !one('.running-line'), 60_000)
  }
  // 代理写的文件都在 notes/ 下。树只画看得见的那一段，所以滚着收一遍路径
  const fresh = async () => (await diff.paths()).filter((path) => path.startsWith('notes/'))
  // 回合还在跑的时候不滚树（滚一遍要几帧，回合可能就在这几帧里结束）：只看画着的行，主要靠版本没变来判断
  const drawn = () => diff.files().some((file) => file.path.startsWith('notes/'))

  const before = diff.version()
  const asked = await diff.asked()
  const turns = all('.turn').length
  await kit.say('改文件')
  await until('对话里出了“改了文件”', () => one('.turn:last-child .steps-head'), 20_000)
  const duringTurn = { sameVersion: diff.version() === before, listed: drawn() }
  await turnDone(turns)
  await diff.settled(before)
  const afterTurn = { moved: diff.version() !== before, listed: await fresh() }
  const refreshes = (await diff.asked()).refreshes - asked.refreshes

  // 从对话里去：点开那条“改了文件”，点它上面的入口
  const turn = one('.turn:last-child') as HTMLElement
  one<HTMLElement>('.proc-head[aria-expanded="false"]', turn)?.click()
  ;(
    await until('步骤组', () => one<HTMLElement>('.steps-head[aria-expanded="false"]', turn))
  )?.click()
  const row = await until('步骤组里那条改了文件', () =>
    one<HTMLElement>('.item-head:not(:disabled)', turn),
  )
  if (row.getAttribute('aria-expanded') !== 'true') row.click()
  const entry = await until('“在差异面板里看”', () => all('.file-diff', turn).at(-1))
  entry.click()
  const wanted = entry.dataset.path ?? ''
  await until(
    `差异里选中了 ${wanted}`,
    () => diff.treeRow(wanted)?.getAttribute('aria-current') === 'true',
  )
  const fromTranscript = all('.dt-row[aria-current="true"]')
    .map((item) => item.dataset.path ?? '')
    .join(',')

  // 面板收着：回合照常，差异不去取
  const open = await diff.asked()
  const seen = diff.version()
  kit.toggle()
  await until('侧面板收起', () => !kit.sideOpen())
  const again = all('.turn').length
  await kit.say('改大文件')
  await turnDone(again)
  await kit.sleep(2500)
  // 收着的这段时间里取了几次：打开那一下会取一次，所以先问再打开
  const whileClosed = (await diff.asked()).refreshes - open.refreshes
  kit.toggle()
  await until('侧面板打开', () => kit.sideOpen())
  await diff.settled(seen)
  const listed = await fresh()

  // 对话里太长不展开的那一处：有去差异面板的入口
  const lastTurn = one('.turn:last-child') as HTMLElement
  one<HTMLElement>('.proc-head[aria-expanded="false"]', lastTurn)?.click()
  ;(
    await until('步骤组', () => one<HTMLElement>('.steps-head[aria-expanded="false"]', lastTurn))
  )?.click()
  const item = await until('步骤组里那条改了文件', () =>
    one<HTMLElement>('.item-head:not(:disabled)', lastTurn),
  )
  if (item.getAttribute('aria-expanded') !== 'true') item.click()
  const toPanel = await until('太长不展开的那一处上的入口', () =>
    one<HTMLElement>('.diff-open', lastTurn),
  )
  const note = kit.text(toPanel.parentElement)
  const big = toPanel.dataset.path ?? ''
  toPanel.click()
  await until(
    `差异里选中了 ${big}`,
    () => diff.treeRow(big)?.getAttribute('aria-current') === 'true',
  )
  const picked = all('.dt-row[aria-current="true"]')
    .map((row) => row.dataset.path ?? '')
    .join(',')

  // 这一回合新写的那个文件后来没了（这里把它删掉）：再从对话里点过去，说一声它现在没有改动
  const goneFile = 'notes/agent-2.md'
  const beforeGone = diff.version()
  diff.act(goneFile, 'discard')
  const dialog = await until('删除的确认框', () => one<HTMLDialogElement>('dialog.confirm'))
  one<HTMLButtonElement>('.confirm-yes', dialog)?.click()
  await diff.settled(beforeGone)
  all('.file-diff', lastTurn)
    .find((button) => button.dataset.path === goneFile)
    ?.click()
  await kit.seen(() => kit.toast('diff-wanted') !== '', 10_000)
  const goneToast = kit.toast('diff-wanted')
  return {
    duringTurn,
    afterTurn,
    refreshes,
    fromTranscript,
    closed: { refreshes: whileClosed, listed },
    tooLong: { note, picked },
    goneToast,
  }
}

export interface NotesSeen {
  /** 点了行号：那一行底下出了写批注的框 */
  editor: boolean
  /** 按着 Shift 再点一行：框上写的是哪几行 */
  rangeLabel: string
  /** 存了之后：行底下有一张批注；输入区的底栏上有个小牌子 */
  card: string
  chip: string
  /** 换一个会话再回来：批注还在 */
  kept: boolean
  /** 发了一条消息：对话里那条消息的全文；发完小牌子和批注都没了 */
  sent: string
  cleared: boolean
}

export async function mockNotes(session: string, other: string): Promise<NotesSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, text } = kit
  const file = 'packages/ui/src/app/App.tsx'
  diff.treeRow(file)?.click()
  const picks = await until('App.tsx 上能点的行号', () => {
    const found = diff.rows(file).flatMap((row) => all('button.dn-pick[data-side="next"]', row))
    return found.length >= 3 ? found : null
  })
  picks[1]?.click()
  await until('写批注的框', () => one('.dnote-edit'))
  const editor = Boolean(one('.dnote-edit textarea'))
  picks[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
  await until('选了两行', () => all('button.dn-pick.on').length >= 2)
  const rangeLabel = text(one('.dnote-edit .dim'))
  const input = await until('批注的输入框', () => one<HTMLTextAreaElement>('.dnote-edit textarea'))
  kit.write(input, '这两行的文案再短一点')
  await kit.frame()
  one<HTMLButtonElement>('[data-act="note-save"]')?.click()
  await until('批注存下了', () => one('.dnote-card'))
  const card = text(one('.dnote-card .dnote-text'))
  const chip = text(await until('输入区的小牌子', () => one('.cmp-notes')))

  await kit.openSession(other)
  await kit.openSession(session)
  await diff.settled()
  diff.treeRow(file)?.click()
  const kept = await kit.seen(() => one('.dnote-card') && one('.cmp-notes'), 8000)

  const turns = all('.turn').length
  await kit.say('按批注改一下')
  await until('新的回合出来', () => all('.turn').length > turns, 20_000)
  const sent = text(await until('发出去的那条消息', () => one('.turn:last-child .umsg-text')))
  const cleared = await kit.seen(() => !one('.cmp-notes') && !one('.dnote-card'), 8000)
  await until('回合结束', () => !one('.running-line'), 60_000)
  return { editor, rangeLabel, card, chip, kept, sent, cleared }
}

export interface ManySeen {
  mode: string
  entries: number
  treeRows: number
  /** 页面上实际画了几行树（只画看得见的） */
  treeDrawn: number
  heads: number
  /** 收起再展开三百个文件的那个目录 */
  fold: Frames<number>
  /** 把树从头滚到尾 */
  scroll: Frames<number>
  /** 连着点十次“下一个文件” */
  step: Frames<string>
  /** 滚完之后最后一行在不在 */
  lastShown: boolean
}

export async function mockMany(session: string): Promise<ManySeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, frame } = kit
  await kit.openSession(session)
  await diff.open()
  const box = await diff.settled()
  const list = await until('变了的文件那一栏', () => one<HTMLElement>('.dt-list'))
  const total = () => Number(list.dataset.rows ?? 0)
  const treeRows = total()
  const treeDrawn = all('.dt-row').length
  // 树只画看得见的那一段：那个目录排在八十多行之后，先滚到它
  const guides = 'content/guides'
  for (
    let top = 0;
    top < list.scrollHeight && !diff.treeRow(guides);
    top += list.clientHeight / 2
  ) {
    list.scrollTop = top
    await frame()
  }
  const dir = await until('三百个文件的那个目录', () => diff.treeRow(guides))
  dir.scrollIntoView({ block: 'start' })
  await frame()
  const fold = await kit.frames(async () => {
    diff.treeRow(guides)?.click()
    await until('收起来了', () => total() < treeRows - 200)
    diff.treeRow('content/guides')?.click()
    await until('又展开了', () => total() === treeRows)
    return total()
  })
  const scroll = await kit.frames(async () => {
    const end = list.scrollHeight - list.clientHeight
    for (let at = 0; at <= 24; at++) {
      list.scrollTop = (end * at) / 24
      await frame()
    }
    return list.scrollTop
  })
  const lastShown = Boolean(
    all('.dt-row[data-kind="file"]').at(-1)?.dataset.path?.startsWith('static/legacy/page-040'),
  )
  list.scrollTop = 0
  await frame()
  const step = await kit.frames(async () => {
    for (let n = 0; n < 10; n++) {
      const was = one('.dstep-at')?.textContent
      one<HTMLButtonElement>('[data-act="next"]')?.click()
      await until(
        '换到下一个文件',
        () => one('.dstep-at')?.textContent !== was && box.dataset.load === 'ready',
      )
    }
    return one('.dstep-at')?.textContent ?? ''
  })
  return {
    mode: box.dataset.mode ?? '',
    entries: diff.count(),
    treeRows,
    treeDrawn,
    heads: all('.dp-head').length,
    fold,
    scroll,
    step,
    lastShown,
  }
}

export interface PlacesSeen {
  /**
   * build-01 上那个仓库：改了上万行的文件、几万行的日志、单行很长的文件各显示成什么；
   * 拿那个单行很长的文件看折行：合并着看、不折的时候它是一行高、内容区能横着滚，折了之后变高
   */
  huge: {
    mode: string
    long: string
    longRows: number
    log: string
    minifiedCut: boolean
    wrap: { off: number; on: number; sideways: boolean }
  }
  /** 干净的仓库 */
  clean: string
  /** 不是仓库的目录：一开始说什么；回合里改了文件之后显示的是什么、有没有范围和暂存的按钮 */
  plain: {
    before: string
    source: string
    files: string[]
    scopeShown: boolean
    acts: number
    banner: string
  }
  /** nas（起不了进程）、没连上的设备各说什么 */
  unsupported: string
  offline: string
}

export async function mockPlaces(names: {
  huge: string
  clean: string
  loose: string
  noSpawn: string
  offline: string
}): Promise<PlacesSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, text } = kit
  const said = () => text(one('.dz'))

  await kit.openSession(names.huge)
  await diff.open()
  const box = await diff.settled()
  const pick = async (path: string) => {
    const row = await until(`树上的 ${path}`, () => diff.treeRow(path))
    row.click()
    await until(`${path} 的文件头`, () => diff.head(path) && box.dataset.load !== 'loading')
    await kit.frame()
  }
  await pick('fixtures/long.ts')
  const long = diff.note('fixtures/long.ts')
  const longRows = diff.rows('fixtures/long.ts').length
  await pick('fixtures/big.log')
  const log = diff.note('fixtures/big.log')
  await pick('fixtures/minified.js')
  await until('minified.js 的行', () => diff.rows('fixtures/minified.js').length > 0)
  const minifiedCut = Boolean(one('.dp .dr-cut'))
  const pane = () => diff.pane() as HTMLElement
  const wasSplit = pane().dataset.layout === 'split'
  if (wasSplit) diff.tool('layout')
  await until('合并着看', () => pane().dataset.layout === 'unified')
  if (pane().dataset.wrap === 'on') diff.tool('wrap')
  await until('不折行', () => pane().dataset.wrap === 'off')
  await kit.frame()
  const tallest = () =>
    Math.max(0, ...diff.rows('fixtures/minified.js').map((row) => row.offsetHeight))
  const off = tallest()
  const sideways = pane().scrollWidth > pane().clientWidth + 100
  diff.tool('wrap')
  await until('折行开了', () => pane().dataset.wrap === 'on')
  await kit.frame()
  await kit.frame()
  const on = tallest()
  diff.tool('wrap')
  await until('折行关了', () => pane().dataset.wrap === 'off')
  if (wasSplit) diff.tool('layout')
  const huge = {
    mode: box.dataset.mode ?? '',
    long,
    longRows,
    log,
    minifiedCut,
    wrap: { off, on, sideways },
  }

  await kit.openSession(names.clean)
  await diff.open()
  await until('干净的仓库说没有改动', () => one('.dz[data-state="clean"]'))
  const clean = said()

  await kit.openSession(names.loose)
  await diff.open()
  await until('不是仓库的目录有说法', () => one('.dz[data-why="notRepo"]'))
  const before = said()
  const turns = all('.turn').length
  await kit.say('改文件')
  await until('新的回合出来', () => all('.turn').length > turns, 20_000)
  await until(
    '本回合的改动显示出来',
    () => diff.box()?.dataset.source === 'turn' && diff.box()?.dataset.phase === 'ready',
    30_000,
  )
  await until('回合结束', () => !one('.running-line'), 60_000)
  const plain = {
    before,
    source: diff.box()?.dataset.source ?? '',
    files: diff.files().map((file) => `${file.status} ${file.path}`),
    scopeShown: Boolean(one('.db-seg')),
    acts: all('.dp-head [data-act]').length,
    banner: text(one('.dnote')),
  }

  await kit.openSession(names.noSpawn)
  await diff.open()
  await until('起不了进程的设备有说法', () => one('.dz[data-why="unsupported"]'))
  const unsupported = said()

  await kit.openSession(names.offline)
  if (!kit.sideOpen()) kit.toggle()
  await until('没连上的设备有说法', () => one('.diffs .dz'))
  const offline = said()
  return { huge, clean, plain, unsupported, offline }
}

export interface NarrowSeen {
  stacked: string
  layout: string
  layoutDisabled: boolean
  /** 文件那一栏在内容的上面（它的底不低于内容区的顶） */
  treeAbove: boolean
  /** 内容区有没有被挤没（高度，像素） */
  paneHeight: number
}

/** 窗口缩到最窄之后（主进程缩的，inner 是页面该看到的宽度） */
export async function narrowSeen(session: string, inner: number): Promise<NarrowSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, until } = kit
  await until(`页面宽度到 ${inner}`, () => window.innerWidth === inner)
  await kit.openSession(session)
  await diff.open()
  const box = await diff.settled()
  await until('窄的时候上下摆', () => box.dataset.stack === 'on', 5000).catch(() => null)
  const tree = one('.dt')?.getBoundingClientRect()
  const pane = diff.pane()?.getBoundingClientRect()
  return {
    stacked: box.dataset.stack ?? '',
    layout: diff.pane()?.dataset.layout ?? '',
    layoutDisabled: one<HTMLButtonElement>('.db [data-tool="layout"]')?.disabled === true,
    treeAbove: Boolean(tree && pane && tree.bottom <= pane.top + 1),
    paneHeight: Math.round(pane?.height ?? 0),
  }
}

export interface RoomySeen {
  /** 面板拖到多宽了 */
  side: number
  stacked: string
  layout: string
  /** 文件那一栏在内容的左边 */
  treeLeft: boolean
}

/** 窗口放宽之后（主进程放的，inner 是页面该看到的宽度）：面板拖宽，文件那一栏回到左边，照样并排 */
export async function roomySeen(session: string, inner: number): Promise<RoomySeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, until } = kit
  await until(`页面宽度到 ${inner}`, () => window.innerWidth === inner)
  await kit.openSession(session)
  await diff.open()
  const box = await diff.settled()
  const side = await diff.resize(840)
  await until('宽的时候左右摆', () => box.dataset.stack === 'off', 5000).catch(() => null)
  await kit.frame()
  const tree = one('.dt')?.getBoundingClientRect()
  const pane = diff.pane()?.getBoundingClientRect()
  return {
    side,
    stacked: box.dataset.stack ?? '',
    layout: diff.pane()?.dataset.layout ?? '',
    treeLeft: Boolean(tree && pane && tree.right <= pane.left + 1),
  }
}

export interface LookSeen {
  /**
   * 每一套（皮肤/明暗）：加的行和底色的对比｜删的行和底色的对比｜加的和删的两种底色隔多远｜字在加的行上的对比｜字在删的行上的对比。
   * 对比是两种颜色（叠在面板底色上之后）的亮度比；“隔多远”是两种颜色在红绿蓝三个数上的距离
   * （加的偏绿、删的偏红，亮度差不多，靠亮度比分不出来）
   */
  looks: {
    name: string
    add: number
    del: number
    between: number
    inkOnAdd: number
    inkOnDel: number
  }[]
  english: string[]
  chinese: string[]
}

export async function diffLook(session: string): Promise<LookSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, text } = kit
  await kit.openSession(session)
  await diff.open()
  await diff.settled()
  if (diff.pane()?.dataset.layout !== 'unified') diff.tool('layout')
  await until('合并着看', () => diff.pane()?.dataset.layout === 'unified')
  await until('有加的行和删的行', () => one('.dr.one.add') && one('.dr.one.del'))
  // 换皮肤、明暗、语言走界面给验收留的口子（window.__litchLook），不直接改根元素上的属性
  const appearance = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const was = appearance.get()
  const parse = (color: string): [number, number, number, number] => {
    const mix = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/.exec(color)
    if (mix)
      return [
        Number(mix[1]) * 255,
        Number(mix[2]) * 255,
        Number(mix[3]) * 255,
        mix[4] === undefined ? 1 : Number(mix[4]),
      ]
    const parts = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
  }
  type Rgb = [number, number, number]
  const over = (top: [number, number, number, number], base: Rgb): Rgb => [
    top[0] * top[3] + base[0] * (1 - top[3]),
    top[1] * top[3] + base[1] * (1 - top[3]),
    top[2] * top[3] + base[2] * (1 - top[3]),
  ]
  const luminance = (color: Rgb) => {
    const [r, g, b] = color.map((value) => {
      const unit = value / 255
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
    }) as Rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: Rgb, b: Rgb) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100
  }
  const background = (element: Element | null) =>
    parse(element ? getComputedStyle(element).backgroundColor : '')
  const looks: LookSeen['looks'] = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      appearance.set({ skin, theme })
      await kit.frame()
      await kit.frame()
      const [pr, pg, pb] = background(diff.pane())
      const base: Rgb = [pr, pg, pb]
      const add = over(background(one('.dr.one.add')), base)
      const del = over(background(one('.dr.one.del')), base)
      const [ir, ig, ib] = parse(getComputedStyle(one('.dr.one.add .dc') as Element).color)
      const ink: Rgb = [ir, ig, ib]
      looks.push({
        name: `${skin}/${theme}`,
        add: contrast(add, base),
        del: contrast(del, base),
        between: Math.round(Math.hypot(add[0] - del[0], add[1] - del[1], add[2] - del[2])),
        inkOnAdd: contrast(ink, add),
        inkOnDel: contrast(ink, del),
      })
    }
  }
  appearance.set({ skin: was.skin, theme: was.theme })
  const words = () => [
    text(one('.side-tab[data-tab="diff"]')),
    all('.db-seg button')
      .map((button) => text(button))
      .join('/'),
    one<HTMLInputElement>('.dt-search')?.placeholder ?? '',
    one('.db [data-tool="wrap"]')?.getAttribute('aria-label') ?? '',
  ]
  appearance.set({ lang: 'en' })
  await kit.seen(() => text(one('.side-tab[data-tab="diff"]')) === 'Diff', 3000)
  const english = words()
  appearance.set({ lang: was.lang })
  await kit.seen(() => text(one('.side-tab[data-tab="diff"]')) === '差异', 3000)
  const chinese = words()
  diff.tool('layout')
  return { looks, english, chinese }
}
