// 文件面板的验收（模拟核心）：文件查看器。预览和固定、上色、六千行的文件、一行特别长的文件、
// 各种显示不了的文件的占位、内容只当字显示、滚动位置。编排在 probe-files-run.mts。
import type { FilesKit, FileTabSeen } from './probe-files-kit.mjs'

export interface LongSeen {
  /** 点下去到内容出来、到颜色上完，各多久（毫秒） */
  shownMs: number
  paintedMs: number
  mode: string
  gaps: number[]
  lines: number
  /** 页面上真的画了多少行 */
  dom: number
  /** 滚到第三千行：那一行画出来了、也上了色 */
  farShown: boolean
  farPainted: boolean
  /** 一帧挪一段一直滚到底，这段时间里的帧间隔；有几帧看得见的地方是空的 */
  rollGaps: number[]
  blank: number
  /** 换到别的文件再换回来，还在刚才滚到的地方（差多少像素） */
  scrollDrift: number
}

export interface ViewSeen {
  /** 还没开文件的时候查看器里写的什么 */
  none: string
  /** 每一步之后开着的文件。写成“路径[*正看着的][~预览]” */
  steps: string[]
  /** README.md：认出的语言、上色走的哪条路、有多少个上了色的片段、底下那一条写的什么 */
  language: string
  paint: string
  spans: number
  foot: string
  readonly: boolean
  /** 树里选中的跟着正看着的文件走 */
  selectedFollows: boolean
  /** 点“重新读取”：这个文件向设备多读了一次 */
  reloads: [number, number]
  long: LongSeen
  /** 一行特别长的：不上色，那一行截断了显示 */
  minifiedPaint: string
  minifiedCut: string
  minifiedShown: number
  /** 各种显示不了的：每项写成“文件｜占位的种类｜标题｜说明” */
  holds: string[]
  /** 不是 UTF-8 的：照样显示，带一个“编码不明”的标记 */
  lossyText: string
  lossyPill: string
  /** 内容里的标记只当字显示：页面上没有多出脚本和图片，脚本也没跑 */
  htmlAsText: boolean
  htmlLeaked: string
}

export async function mockView(): Promise<ViewSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame } = kit
  const shape = (tabs: FileTabSeen[]) =>
    tabs.map((tab) => `${tab.path}${tab.active ? '*' : ''}${tab.preview ? '~' : ''}`).join(' ')
  const steps: string[] = []
  const mark = (what: string) => steps.push(`${what}：${shape(kit.tabs())}`)
  const tabButton = (relative: string) =>
    all('.fv-tab').find((tab) => tab.dataset.path === kit.full(relative)) ?? null

  kit.tree()?.scrollTo({ top: 0 })
  await frame()
  const none = text(one('.fv-none'))

  // ---------- 预览与固定 ----------
  await kit.open('README.md')
  mark('单击 README.md')
  const paint = await kit.painted()
  const view = kit.code() as HTMLElement
  const language = view.dataset.language ?? ''
  const spans = all('span[class^="hljs-"]', view).length
  const foot = text(one('.fv-foot .ell'))
  const readonly = Boolean(one('.fv-foot .pill.mute'))
  await kit.open('Makefile')
  mark('单击 Makefile')
  await kit.open('package.json', true)
  mark('双击 package.json')
  await kit.open('AGENTS.md')
  mark('单击 AGENTS.md')
  const selectedFollows = kit.rows().find((row) => row.selected)?.path === 'AGENTS.md'
  const previewTab = one('.fv-tab-btn', tabButton('AGENTS.md'))
  if (previewTab) kit.double(previewTab)
  await until('预览固定下来了', () => kit.tabs().every((tab) => !tab.preview))
  mark('双击 AGENTS.md 的标签')
  await kit.open('README.md')
  mark('单击 README.md')
  one<HTMLButtonElement>('[data-tool="close"]', tabButton('AGENTS.md'))?.click()
  await until('关掉了一个', () => kit.tabs().length === 2)
  mark('关掉 AGENTS.md')
  kit.click(one('.fv-tab-btn', tabButton('package.json')) as HTMLElement)
  await kit.viewed('package.json')
  mark('点 package.json 的标签')

  // ---------- 重新读取 ----------
  const readsOf = async () => {
    const { reads } = await kit.check()
    return Object.entries(reads).find(([path]) => path.endsWith('/package.json'))?.[1] ?? 0
  }
  const readsBefore = await readsOf()
  one<HTMLButtonElement>('.fv-head [data-tool="reload"]')?.click()
  let readsAfter = readsBefore
  for (let tries = 0; tries < 60 && readsAfter === readsBefore; tries++) {
    await kit.sleep(50)
    readsAfter = await readsOf()
  }

  // ---------- 六千行的文件 ----------
  await kit.expand('fixtures')
  const longRow = await kit.rowShown('fixtures/long.ts')
  const opened = await kit.frames(async () => {
    const started = performance.now()
    kit.click(longRow)
    await kit.viewed('fixtures/long.ts', 60_000)
    const shownMs = performance.now() - started
    const mode = await kit.painted(60_000)
    return { shownMs, paintedMs: performance.now() - started, mode }
  })
  const longView = kit.code() as HTMLElement
  const lines = Number(longView.dataset.lines ?? 0)
  const dom = all('.cl', longView).length
  longView.scrollTop = 2999 * 20
  const far = await kit.seen(() => kit.lineInView(3000), 5000)
  const farLine = one('.cl[data-line="3000"]', longView)
  const farPainted = await kit.seen(() => all('span[class^="hljs-"]', farLine).length > 0, 5000)
  let blank = 0
  const rolled = await kit.frames(async () => {
    const bottom = longView.scrollHeight - longView.clientHeight
    const count = 60
    for (let step = 1; step <= count; step++) {
      longView.scrollTop = Math.round((bottom * step) / count)
      await frame()
      const box = longView.getBoundingClientRect()
      const visible = all('.cl', longView).some((line) => {
        const at = line.getBoundingClientRect()
        return at.bottom > box.top && at.top < box.bottom
      })
      if (!visible) blank++
    }
  })
  // 停在一个认得出来的位置上，换走再换回来
  longView.scrollTop = 1234 * 20
  await frame()
  await frame()
  await kit.open('package.json')
  await kit.open('fixtures/long.ts')
  const back = await until('回到那个文件', () => kit.code())
  await frame()
  const scrollDrift = Math.abs(back.scrollTop - 1234 * 20)
  const long: LongSeen = {
    shownMs: opened.value.shownMs,
    paintedMs: opened.value.paintedMs,
    mode: opened.value.mode,
    gaps: opened.gaps,
    lines,
    dom,
    farShown: far,
    farPainted,
    rollGaps: rolled.gaps,
    blank,
    scrollDrift,
  }

  // ---------- 一行特别长的 ----------
  await kit.open('fixtures/minified.js')
  const minifiedPaint = await kit.painted()
  const minifiedCut = text(one('.cl-cut'))
  const minifiedShown = (one('.cl[data-line="1"] .lc')?.textContent ?? '').length

  // ---------- 显示不了的 ----------
  await kit.expand('docs')
  await kit.expand('docs/images')
  const holds: string[] = []
  for (const file of [
    'fixtures/big.log',
    'fixtures/blob.dat',
    'docs/images/shot.png',
    'fixtures/gone.txt',
  ]) {
    await kit.open(file)
    const hold = await until(`${file} 的占位`, () => one<HTMLElement>('.fv-hold'))
    holds.push([file, hold.dataset.hold, text(one('b', hold)), text(one('span', hold))].join('｜'))
  }
  await kit.open('fixtures/latin1.txt')
  await kit.painted()
  const lossyText = (one('.cl[data-line="1"] .lc')?.textContent ?? '').trim()
  const lossyPill = text(one('.fv-foot .pill.wait'))

  // ---------- 内容只当字显示 ----------
  await kit.open('docs/snippet.html')
  await kit.painted()
  const htmlView = kit.code() as HTMLElement
  const leaks = [
    one('script, img, p', htmlView) ? '查看器里多出了元素' : '',
    document.getElementById('litch-leak') ? '页面上有了文件里的元素' : '',
    '__litchLeak' in window ? '文件里的脚本跑了' : '',
  ].filter(Boolean)
  const htmlAsText = (htmlView.textContent ?? '').includes(
    '<script>window.__litchLeak = 2</script>',
  )

  return {
    none,
    steps,
    language,
    paint,
    spans,
    foot,
    readonly,
    selectedFollows,
    reloads: [readsBefore, readsAfter],
    long,
    minifiedPaint,
    minifiedCut,
    minifiedShown,
    holds,
    lossyText,
    lossyPill,
    htmlAsText,
    htmlLeaked: leaks.join('；'),
  }
}

export interface SearchSeen {
  /** 找 toolpy：结果里有谁、标出来的字 */
  hits: string[]
  marked: string
  /** 找之前，命中的那个文件所在的目录还没被问过：结果不是从已经展开的行里滤出来的 */
  parentAsked: number
  /** 往下、往上：走到第几条 */
  walked: number[]
  /** 回车：固定打开第一条 */
  opened: string
  /** 按 Esc 清掉要找的字，回到树上：那个文件露出来了、是选中的 */
  cleared: boolean
  revealed: boolean
  /** 找不到的时候写的什么 */
  none: string
  /** 找一个目录，点它：回到树上、露出来（它在三万个条目的那个目录里） */
  dirHit: string
  dirRevealed: boolean
  /** 结果上点右键：菜单出来了 */
  hitMenu: number
}

export async function mockSearch(): Promise<SearchSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame } = kit
  const input = await until('找文件的框', () => one<HTMLInputElement>('.ft-search'))
  const before = await kit.check()
  const parentAsked = Object.entries(before.lists).filter(([path]) =>
    path.endsWith('/scripts'),
  ).length

  kit.search('toolpy')
  await until('结果出来了', () => one('.ft-hits')?.dataset.query === 'toolpy')
  const found = kit.hits()
  const hits = found.map((hit) => `${hit.kind}:${hit.path}`)
  const marked = found[0]?.marked ?? ''
  const activeIndex = () =>
    all('.ft-hit').findIndex((hit) => hit.getAttribute('aria-selected') === 'true')
  const walked = [activeIndex()]
  kit.search('serve')
  await until('换了一批结果', () => one('.ft-hits')?.dataset.query === 'serve')
  kit.press(input, 'ArrowDown')
  await frame()
  walked.push(activeIndex())
  kit.press(input, 'ArrowUp')
  await frame()
  walked.push(activeIndex())
  // 结果上点右键
  const firstHit = one('.ft-hit') as HTMLElement
  kit.context(firstHit)
  const menu = await until('结果上的菜单', () => one('.pick-pop[role="menu"]'))
  const hitMenu = all('button', menu).length
  kit.press(menu, 'Escape')
  await until('菜单收了', () => !one('.pick-pop[role="menu"]'))

  kit.search('toolpy')
  await until('回到第一批', () => one('.ft-hits')?.dataset.query === 'toolpy')
  kit.press(input, 'Enter')
  await kit.viewed('scripts/tool.py')
  const opened = kit
    .tabs()
    .filter((tab) => tab.active)
    .map((tab) => `${tab.path}${tab.preview ? '~' : ''}`)
    .join('')
  kit.press(input, 'Escape')
  const cleared = await kit.seen(() => input.value === '' && kit.tree())
  const revealed = await kit.seen(
    () => kit.row('scripts/tool.py')?.getAttribute('aria-selected') === 'true',
  )

  kit.search('zzzzqqqq')
  const none = text(await until('找不到的说明', () => one('.ft-hold[data-hold="ready"]')))

  kit.search('group17')
  const dir = await until('目录的结果', () =>
    all('.ft-hit').find((hit) => hit.dataset.kind === 'dir'),
  )
  const dirHit = dir.dataset.path?.slice(kit.root().length + 1) ?? ''
  kit.click(dir)
  const dirRevealed = await kit.seen(
    () => kit.row(dirHit)?.getAttribute('aria-selected') === 'true',
    20_000,
  )
  // 收拾：三万行的目录收回去
  await kit.scrollTree(0)
  await kit.collapse('fixtures/many').catch(() => {})

  return {
    hits,
    marked,
    parentAsked,
    walked,
    opened,
    cleared,
    revealed,
    none,
    dirHit,
    dirRevealed,
    hitMenu,
  }
}
