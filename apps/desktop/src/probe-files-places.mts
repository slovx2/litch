// 文件面板的验收（模拟核心）：面板跟着眼前的会话换地方、各棵树的状态各记各的；
// 不提供文件访问的设备、不提供找文件的设备、没连上的设备各说了什么；没有侧面板的页面。
// 新建对话页上面板怎么跟在 probe-files-room.mts。
// 编排在 probe-files-run.mts。
import type { FilesKit } from './probe-files-kit.mjs'

export interface PlacesSeen {
  /** 起头那个会话：面板挂在哪（设备/项目｜根） */
  home: string
  /** 换到另一个项目的会话：挂到了哪；那棵树是从头开始的（没展开的、没开着的文件、没滚过） */
  other: string
  otherFresh: string
  /** 再换回来：展开的还展开着（行数）、滚到的地方、开着的文件、选中的，都还在 */
  kept: {
    rows: number
    rowsBefore: number
    scroll: number
    scrollBefore: number
    tabs: string
    tabsBefore: string
  }
  keptSelected: boolean
  /** 不属于任何项目的会话：根是它的工作目录 */
  loose: string
  looseRows: number
  /** 不提供文件访问的设备：树那里写的什么（种类｜标题｜说明）；有没有“重试” */
  unsupported: string
  unsupportedRetry: boolean
  /** 提供文件访问、不提供找文件的设备：树有没有，找文件那里写的什么 */
  noSearchRows: number
  noSearch: string
  /** 没连上的设备：树那里写的什么；刷新按钮是不是按不了 */
  offline: string
  offlineRefresh: boolean
  /** 开“设备”页：面板不显示；回到会话：又回来了，还是开着的 */
  hiddenOnPage: boolean
  backFromPage: boolean
}

export async function mockPlaces(titles: {
  home: string
  other: string
  loose: string
  noFiles: string
  noSearch: string
  offline: string
}): Promise<PlacesSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, text, frame } = kit
  const placeNow = () => {
    const panel = kit.side()
    return `${panel?.dataset.device}/${panel?.dataset.workspace}｜${kit.root()}`
  }
  /** 等面板换到了这个会话该在的地方：设备对上了，树要么有行、要么说了为什么没有 */
  const settle = async (title: string, device: string) => {
    await kit.openSession(title)
    await until(
      `面板跟到了 ${device}`,
      () => kit.side()?.dataset.device === device && kit.files()?.dataset.device === device,
    )
    await until('树有了结果', () => kit.rows().length > 0 || one('.ft-hold'), 30_000)
    await frame()
  }
  const holdSeen = () => {
    const hold = one('.ft-hold')
    return hold ? [hold.dataset.hold, text(one('b', hold)), text(one('span', hold))].join('｜') : ''
  }
  const shape = () =>
    kit
      .tabs()
      .map((tab) => `${tab.path}${tab.active ? '*' : ''}${tab.preview ? '~' : ''}`)
      .join(' ')

  // ---------- 起头的那棵树：展开、开文件、滚 ----------
  await settle(titles.home, 'local')
  if (!kit.sideOpen()) {
    kit.toggle()
    await until('面板打开', () => kit.sideOpen())
  }
  const home = placeNow()
  await kit.scrollTree(0)
  await kit.expand('docs')
  await kit.open('docs/guide.md', true)
  await kit.expand('fixtures')
  await kit.expand('fixtures/many', 60_000)
  await until('三万行', () => kit.rowCount() > 30_000, 60_000)
  // 点目录也会选中它：这时候选中的是最后点的那个
  const selectedBefore = kit.rows().find((row) => row.selected)?.path ?? ''
  await kit.scrollTree(5000)
  const rowsBefore = kit.rowCount()
  const scrollBefore = kit.tree()?.scrollTop ?? 0
  const tabsBefore = shape()

  // ---------- 另一个项目 ----------
  await settle(titles.other, 'local')
  await until('换了一个根', () => !placeNow().endsWith(home.split('｜')[1] ?? ''))
  await until('那棵树取到了根', () => kit.rows().length > 0)
  const other = placeNow()
  const otherFresh = `${kit.rowCount() < 100 ? '没展开' : `有 ${kit.rowCount()} 行`}｜${shape() || '没开文件'}｜滚到 ${kit.tree()?.scrollTop ?? -1}`

  // ---------- 回来 ----------
  await settle(titles.home, 'local')
  await until('回到原来的根', () => placeNow() === home)
  await until('展开的还在', () => kit.rowCount() === rowsBefore, 30_000).catch(() => null)
  await kit.seen(() => Math.abs((kit.tree()?.scrollTop ?? 0) - scrollBefore) < 2, 3000)
  const kept = {
    rows: kit.rowCount(),
    rowsBefore,
    scroll: kit.tree()?.scrollTop ?? -1,
    scrollBefore,
    tabs: shape(),
    tabsBefore,
  }
  await kit.scrollTree(0)
  const keptSelected = await kit.seen(
    () =>
      selectedBefore !== '' && kit.row(selectedBefore)?.getAttribute('aria-selected') === 'true',
    3000,
  )
  await kit.collapse('fixtures/many')
  await kit.collapse('fixtures')

  // ---------- 不属于项目的会话 ----------
  await settle(titles.loose, 'local')
  await until('根换成了它的工作目录', () => placeNow() !== home)
  const loose = placeNow()
  const looseRows = kit.rowCount()

  // ---------- 降级的设备 ----------
  await settle(titles.noFiles, 'nas')
  await until('说了不提供', () => one('.ft-hold'))
  const unsupported = holdSeen()
  const unsupportedRetry = Boolean(one('.ft-hold button'))

  await settle(titles.noSearch, 'build')
  await until('这台有树', () => kit.rows().length > 0)
  const noSearchRows = kit.rowCount()
  kit.search('serve')
  // 刚打字的那一会儿写的是“正在找”：等到有了结果
  await until(
    '找文件那里说了不提供',
    () => !['idle', 'searching', undefined].includes(one('.ft-hold')?.dataset.hold),
    10_000,
  )
  const noSearch = holdSeen()
  kit.search('')
  await until('回到树上', () => kit.tree())

  await settle(titles.offline, 'gpu')
  await until('没连上的说明', () => one('.ft-hold'))
  const offline = holdSeen()
  const offlineRefresh = one<HTMLButtonElement>('[data-tool="refresh"]')?.disabled === true

  // ---------- 没有侧面板的页面 ----------
  await settle(titles.home, 'local')
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进设备页的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="devices"]'),
    )
  ).click()
  const hiddenOnPage = await kit.seen(() => !kit.sideOpen(), 5000)
  await kit.openSession(titles.home)
  const backFromPage = await kit.seen(() => kit.sideOpen() && kit.rows().length > 0, 5000)

  return {
    home,
    other,
    otherFresh,
    kept,
    keptSelected,
    loose,
    looseRows,
    unsupported,
    unsupportedRetry,
    noSearchRows,
    noSearch,
    offline,
    offlineRefresh,
    hiddenOnPage,
    backFromPage,
  }
}

export interface LookSeen {
  /**
   * 每一套（皮肤/明暗）：面板的底色｜皮肤变量要的底色｜选中那一行的底色｜要的｜代码的字体｜要的｜
   * 树上一行多高｜代码一行多高｜字的颜色和底色是不是不一样
   */
  looks: string[]
  /** 英文界面下：面板的名字、标签上的字、开合按钮的名字、找文件的框里的提示、树的名字、“只读” */
  english: string[]
  chinese: string[]
}

export async function filesLook(): Promise<LookSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { one, text } = kit
  // 换皮肤、明暗、语言走界面给验收留的口子，不靠界面上哪个按钮
  const look = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  // 手头要有一个选中的行和一个开着的文字文件
  await kit.scrollTree(0)
  await kit.open('Makefile')
  await kit.painted()
  const clean = (value: string) => value.replace(/\s/g, '')
  /** 让浏览器把皮肤的变量算出来 */
  const wanted = () => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--mono)'
    ;(kit.side() ?? document.body).appendChild(probe)
    const style = getComputedStyle(probe)
    probe.style.backgroundColor = 'var(--panel)'
    const panel = clean(style.backgroundColor)
    probe.style.backgroundColor = 'var(--sel)'
    const sel = clean(style.backgroundColor)
    const font = style.fontFamily.split(',')[0]?.trim() ?? ''
    probe.remove()
    return { panel, sel, font }
  }
  const shown = () => {
    const panel = kit.side()
    const row = one('.ft-row[aria-selected="true"]')
    const line = one('.fv-code .cl')
    const view = kit.code()
    return {
      panel: panel ? clean(getComputedStyle(panel).backgroundColor) : '',
      sel: row ? clean(getComputedStyle(row).backgroundColor) : '',
      font: view ? (getComputedStyle(view).fontFamily.split(',')[0]?.trim() ?? '') : '',
      rowHeight: row?.offsetHeight ?? 0,
      lineHeight: line?.offsetHeight ?? 0,
      ink: row ? clean(getComputedStyle(row).color) : '',
    }
  }
  const before = look.get()
  const looks: string[] = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      // 皮肤和明暗分两次换、中间只隔一帧：换皮肤要等新字体，紧跟着再换明暗的时候前一次还没落地，
      // 后换的不能被先换的盖掉（出过这个毛病）
      look.set({ skin })
      await kit.frame()
      look.set({ theme })
      await kit.frame()
      const want = wanted()
      // 颜色当场换，字体要等字体文件到了才换：等到都对上（一直对不上就照实记下来）
      await kit.seen(() => {
        const now = shown()
        return now.panel === want.panel && now.sel === want.sel && now.font === want.font
      }, 10_000)
      const now = shown()
      looks.push(
        [
          `${skin}/${theme}`,
          now.panel,
          want.panel,
          now.sel,
          want.sel,
          now.font,
          want.font,
          now.rowHeight,
          now.lineHeight,
          now.ink !== now.sel && now.ink !== now.panel ? '看得清' : '字和底一个颜色',
        ].join('｜'),
      )
    }
  }
  look.set({ skin: before.skin })
  await kit.frame()
  look.set({ theme: before.theme })
  await kit.frame()

  const words = () => [
    kit.side()?.getAttribute('aria-label') ?? '',
    text(one('.side-tab')),
    one('.tb-side')?.getAttribute('aria-label') ?? '',
    one<HTMLInputElement>('.ft-search')?.placeholder ?? '',
    kit.tree()?.getAttribute('aria-label') ?? '',
    text(one('.fv-foot .pill.mute')),
  ]
  look.set({ lang: 'en' })
  await kit.seen(() => kit.side()?.getAttribute('aria-label') === 'Side panel', 3000)
  const english = words()
  look.set({ lang: 'zh-CN' })
  await kit.seen(() => kit.side()?.getAttribute('aria-label') === '侧面板', 3000)
  const chinese = words()
  return { looks, english, chinese }
}
