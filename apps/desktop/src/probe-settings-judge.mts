// 设置页验收：量到的东西里哪些算不合格。全过就是空的。
import { BACKDROPS, type ShellLook } from './look.mjs'
import type { AboutSeen, ColdSeen, KeyRow } from './probe-settings-about.mjs'
import type { ScreensSeen, ZoomLists } from './probe-settings-audit.mjs'
import type { ControlsSeen, PageSeen, PreviewSeen } from './probe-settings-page.mjs'
import {
  judgePasswords,
  type PasswordsRemoved,
  type PasswordsSeen,
} from './probe-settings-passwords.mjs'
import { judgeSwitches, type SwitchesSeen } from './probe-settings-switches.mjs'
import { judgeTools, type ToolsSeen } from './probe-settings-tools.mjs'
import type { PersistSeen, TurnSeen } from './probe-settings-turn.mjs'
import type { SizeSeen } from './probe-terminal-size.mjs'

/** 应用菜单里带着键的一项 */
export interface MenuKey {
  /** `id:标识` 或 `role:角色` */
  item: string
  accelerator: string
  label: string
}

export interface ZoomSeen {
  zoom: number
  ratio: number
  minSize: number[]
  wantedMinSize: number[]
  /** 屏幕放得下这一档的最小窗口 */
  roomy: boolean
  inner: number[]
  term: SizeSeen
  lists: ZoomLists
}

export interface FirstSeen {
  /** 屏幕的像素比（缩放是 100% 时页面的像素比该是它） */
  base: number
  pageRatio: number
  page: PageSeen
  menu: {
    settingsItem: boolean
    settingsAt: string
    aboutItem: boolean
    aboutAt: string
    zoomSteps: number[]
  }
  controls: ControlsSeen
  preview: PreviewSeen
  backdrops: Record<string, { light: string; dark: string }>
  keys: KeyRow[]
  menuKeys: MenuKey[]
  about: AboutSeen
  tools: ToolsSeen
  switches: SwitchesSeen
  passwords: { seen: PasswordsSeen; removed: PasswordsRemoved }
  turn: TurnSeen
  screens: ScreensSeen
  zooms: ZoomSeen[]
  persist: PersistSeen
  kept: ShellLook
}

const HOME = 'https://github.com/slovx2/litch'
/** 有 Computer Use 那一组的平台（macOS 和 Windows） */
const hasComputerUse = (platform: string) => platform === 'darwin' || platform === 'win32'
/** 设置页左边的分组和标题：Computer Use 那一组只在 macOS 和 Windows 上有 */
const sectionsOn = (platform: string) =>
  hasComputerUse(platform)
    ? [
        'look',
        'lang',
        'chat',
        'switches',
        'browser',
        'computer',
        'notify',
        'assist',
        'keys',
        'about',
      ]
    : ['look', 'lang', 'chat', 'switches', 'browser', 'notify', 'assist', 'keys', 'about']
const titlesOn = (platform: string, lang: 'zh-CN' | 'en' = 'zh-CN') => {
  const all =
    lang === 'en'
      ? [
          'Appearance',
          'Language',
          'Conversation',
          'Per-harness switches',
          'Built-in browser',
          'Computer Use',
          'Notifications',
          'Config assistant',
          'Shortcuts',
          'About',
        ]
      : [
          '外观',
          '语言',
          '对话',
          '按 harness 开关',
          '内置浏览器',
          'Computer Use',
          '通知',
          '配置助手',
          '快捷键',
          '关于',
        ]
  return hasComputerUse(platform) ? all : all.filter((title) => title !== 'Computer Use')
}
/** 只在没打包时才有的两项菜单，清单里不列（装好的应用里没有） */
const DEV_ONLY = ['role:reload', 'role:toggledevtools']

/** 菜单的加速键写成能比的样子：修饰键换成这种系统上的那一个、排好序、全小写（和界面那边的写法一个规矩） */
function canonical(accelerator: string, mac: boolean): string {
  const names: Record<string, string> = {
    cmdorctrl: mac ? 'cmd' : 'ctrl',
    commandorcontrol: mac ? 'cmd' : 'ctrl',
    command: 'cmd',
    control: 'ctrl',
    option: 'alt',
    plus: '+',
  }
  const parts = accelerator
    .split('+')
    .map((part) => names[part.toLowerCase()] ?? part.toLowerCase())
  const key = parts.pop() ?? ''
  return [...parts.sort(), key].join('+')
}

/** 快捷键一览表和真的应用菜单对账 */
function judgeKeys(rows: KeyRow[], menu: MenuKey[], platform: string): string[] {
  const failed: string[] = []
  const mac = platform === 'darwin'
  if (rows.length < 30) failed.push(`快捷键一览表只有 ${rows.length} 行`)
  for (const row of rows) {
    if (!row.what || !row.caps || row.combos.length === 0 || !row.group) {
      failed.push(`快捷键一览表里“${row.id}”这一行不全：${JSON.stringify(row)}`)
    }
  }
  // 菜单里同一项可以有几个键（放大：加号和等号各一项，后一项的标识带 .plain）
  const inMenu = new Map<string, Set<string>>()
  for (const entry of menu) {
    const item = entry.item.replace(/\.plain$/, '')
    if (DEV_ONLY.includes(item)) continue
    const combos = inMenu.get(item) ?? new Set<string>()
    combos.add(canonical(entry.accelerator, mac))
    inMenu.set(item, combos)
  }
  const listed = new Map(rows.filter((row) => row.menu).map((row) => [row.menu, row]))
  for (const [item, combos] of inMenu) {
    const row = listed.get(item)
    if (!row) {
      failed.push(`应用菜单里的“${item}”（${[...combos].join('、')}）不在快捷键一览表里`)
      continue
    }
    const shown = [...row.combos].sort().join(' ')
    const real = [...combos].sort().join(' ')
    if (shown !== real) {
      failed.push(`“${row.id}”的键对不上：一览表写的是 ${shown}，应用菜单里是 ${real}`)
    }
  }
  for (const [item, row] of listed) {
    if (!inMenu.has(item)) failed.push(`一览表说“${row.id}”在应用菜单里（${item}），菜单里没有`)
  }
  return failed
}

export function judgeFirst(
  seen: FirstSeen,
  hooks: { version: string; minSize: { width: number; height: number } },
  platform: string,
): string[] {
  const failed: string[] = []
  const must = (ok: unknown, what: string) => {
    if (!ok) failed.push(what)
  }
  const same = (actual: unknown, expected: unknown, what: string) =>
    must(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`,
    )
  const { page, menu, controls, preview, about, turn, screens, persist } = seen

  // ---- 设置页：打得开、关得掉、各组都在 ----
  const sections = sectionsOn(platform)
  same(page.sections, sections, '设置页左边的分组')
  same(page.titles, titlesOn(platform), '各组的标题')
  same(page.first, 'look', '设置页默认在哪一组')
  must(page.crumb === '设置', `标题栏上写的不是“设置”：“${page.crumb}”`)
  must(page.entryCurrent, '侧栏底部的齿轮没有标成正开着')
  must(page.panelsHidden, '设置页上还显示着终端面板或侧面板')
  must(page.escCloses, 'Esc 没有关掉设置页回到新建对话页')
  must(page.closeButton, '右上角的叉没有关掉设置页')
  must(page.keyOpens, '按主修饰键加逗号没有打开设置页')
  must(page.toDevices, '设置页左上角的“设备”没有通到设备页')
  must(page.toArchived, '设置页左上角的“已归档对话”没有通到那一页')
  same(page.oldButtons, 0, '侧栏底部的临时按钮')
  must(menu.settingsItem && menu.settingsAt !== '没开', `应用菜单的“设置…”没有打开设置页`)
  must(
    menu.aboutItem && menu.aboutAt === 'about',
    `应用菜单的“关于”没有开到“关于”那一组：${menu.aboutAt}`,
  )
  same(menu.zoomSteps, [1.1, 1, 0.9, 1], '应用菜单里放大、缩小、缩小、实际大小之后的倍数')

  // ---- 控件：点了当场生效 ----
  same(
    controls.steps,
    [
      '皮肤 human→human/system/standard/zh-CN',
      '皮肤 standard→standard/system/standard/zh-CN',
      '皮肤 retro→retro/system/standard/zh-CN',
      '明暗 dark→retro/dark/standard/zh-CN',
      '明暗 light→retro/light/standard/zh-CN',
      '明暗 system→retro/system/standard/zh-CN',
      '密度 compact→retro/system/compact/zh-CN',
      '密度 roomy→retro/system/roomy/zh-CN',
      '密度 standard→retro/system/standard/zh-CN',
      '语言 en→retro/system/standard/en',
      '语言 zh-CN→retro/system/standard/zh-CN',
    ],
    '每点一下之后根元素上的样子',
  )
  same(controls.rowHeights, [24, 32, 28], '三档密度下侧栏一行的高度')
  same(controls.langChoices, ['zh-CN', 'en'], '语言有哪几档')
  same(controls.english, titlesOn(platform, 'en'), '英文的组名')
  same(controls.chinese, titlesOn(platform), '换回中文的组名')
  same(controls.zoomChoices, ['0.8', '0.9', '1', '1.1', '1.25', '1.5'], '缩放有哪几档')
  same(controls.zoomRatios, [0.8, 0.9, 1.1, 1.25, 1.5, 1], '每一档点了之后页面是原来的几倍')
  must(
    Math.abs(seen.pageRatio - seen.base) < 0.01,
    `100% 时页面的像素比不是屏幕的：${seen.pageRatio}`,
  )

  // ---- 预览、底色表 ----
  must(preview.rows.length === 18, `预览只量了 ${preview.rows.length} 张`)
  for (const row of preview.rows) {
    must(!/[≠]/.test(row), `皮肤预览画的不是那种皮肤的变量：${row}`)
  }
  must(preview.distinct, '三张皮肤预览画出来有一样的')
  same(seen.backdrops, BACKDROPS, '页面在各套皮肤下的底色，和外壳里记的那张表')

  // ---- 快捷键、关于 ----
  failed.push(...judgeKeys(seen.keys, seen.menuKeys, platform))
  failed.push(...judgeTools(seen.tools, platform))
  failed.push(...judgeSwitches(seen.switches))
  failed.push(...judgePasswords(seen.passwords.seen, seen.passwords.removed))
  same(about.name, 'Litch', '关于里的名字')
  same(about.version, hooks.version, '关于里的版本')
  must(about.versionLine.includes(hooks.version), `版本那一行没有写版本：“${about.versionLine}”`)
  must(/Electron \d/.test(about.runtime), `运行时那一行不对：“${about.runtime}”`)
  same(about.home, HOME, '项目主页')
  same(about.copied, HOME, '点“复制”之后剪贴板里的')
  must(about.homeSelectable, '项目主页的字不能选')
  same(about.projectKind, 'MIT License', '本项目的许可名')
  same(about.projectHead, 'MIT License', '本项目许可证全文的头一行')
  must(about.projectLength > 500, `本项目许可证的全文太短：${about.projectLength}`)
  must(about.noticesLength > 200, `第三方声明的全文太短：${about.noticesLength}`)
  const expectPackages = Number(process.env.LITCH_LICENSES_COUNT ?? '')
  if (expectPackages > 0) {
    same(about.packages, expectPackages, '第三方包的许可有几份')
    must(about.firstPackageLength > 100, `头一个包（${about.firstPackage}）的许可全文太短`)
  } else {
    must(about.packages === 0 && about.unbundledNote, '没带逐包许可的时候没有说明')
  }

  // ---- 回合正在跑的时候换外观 ----
  must(turn.followHeights >= 2, `贴底那一段内容的高度没有变过（${turn.followHeights} 种）`)
  must(
    turn.followSpread >= 0 && turn.followSpread <= 0.5,
    `贴底时换外观，底边动了 ${turn.followSpread}`,
  )
  must(turn.followGrew > 0, `贴底那一段回答没有接着长（${turn.followGrew}）`)
  must(turn.freeHeights >= 2, `没贴底那一段内容的高度没有变过（${turn.freeHeights} 种）`)
  must(
    turn.freeSpread >= 0 && turn.freeSpread <= 1,
    `没贴底时换外观，那条消息挪了 ${turn.freeSpread}`,
  )
  must(turn.freeKept, `没贴底时换外观之后，盯着的那条消息不在原处了：${turn.freeWhy}`)
  must(turn.toBottomStayed, '没贴底时换外观，“回到底部”中途没了')
  must(turn.freeGrew > 0, `没贴底那一段回答没有接着长（${turn.freeGrew}）`)
  must(turn.finished, '换过外观之后回合没有正常收尾')

  // ---- 六套组合下各屏 ----
  must(screens.cardShown, '量审批卡片那一屏的时候卡片不在')
  must(screens.archivedRows > 0, '量已归档那一屏的时候列表是空的')
  must(screens.taskRows > 0, '量定时任务列表那一屏的时候列表是空的')
  must(screens.taskRuns > 0, '量定时任务详情那一屏的时候运行记录是空的')
  // 对话区三块、审批、已归档、定时任务的列表、详情、表单各六套，设置页各组乘两种语言各六套
  same(screens.rows.length, (3 + 1 + 1 + 3 + sections.length * 2) * 6, '量了多少屏')
  for (const row of screens.rows) {
    must(row.audit.texts > 0, `${row.where}：一处字都没量到`)
    must(row.audit.overflow.length === 0, `${row.where}：横向溢出 ${row.audit.overflow.join('、')}`)
    must(
      row.audit.unreadable.length === 0,
      `${row.where}：读不清的字 ${row.audit.unreadable.slice(0, 6).join('、')}`,
    )
  }

  // ---- 缩放到最小和最大 ----
  for (const zoom of seen.zooms) {
    const name = `缩放 ${Math.round(zoom.zoom * 100)}%`
    same(zoom.ratio, zoom.zoom, `${name}：页面是原来的几倍`)
    same(zoom.minSize, zoom.wantedMinSize, `${name}：窗口最小的大小`)
    if (zoom.roomy) {
      must(
        (zoom.inner[0] ?? 0) >= hooks.minSize.width - 1 &&
          (zoom.inner[1] ?? 0) >= hooks.minSize.height - 1,
        `${name}：窗口缩到最小之后页面里只剩 ${zoom.inner.join('×')}`,
      )
    }
    must(
      zoom.term.rows > 0 && zoom.term.told === `${zoom.term.rows} ${zoom.term.cols}`,
      `${name}：终端里的程序看到的是 ${zoom.term.told}，屏幕上画的是 ${zoom.term.rows} ${zoom.term.cols}`,
    )
    const { lists } = zoom
    must(
      lists.talkOverflow.length === 0,
      `${name}：对话区横向溢出 ${lists.talkOverflow.join('、')}`,
    )
    must(Math.abs(lists.talkGap) <= 1, `${name}：对话区贴底时底边差了 ${lists.talkGap}`)
    // 一行是 24 个样式像素。缩放之后它不一定落在整数个设备像素上，量出来会差千分之几
    must(
      Math.abs(lists.treeRowHeight - 24) < 0.05,
      `${name}：文件树一行的高度是 ${lists.treeRowHeight}，该是 24`,
    )
    must(lists.treeCovers && lists.treeCoversMid, `${name}：文件树画出来的行没有盖满看得见的地方`)
    must(lists.treePadExact, `${name}：文件树垫高的那一层不是整数行`)
    must(
      lists.sideOverflow.length === 0,
      `${name}：侧面板横向溢出 ${lists.sideOverflow.join('、')}`,
    )
  }

  // ---- 重开还在 ----
  same(persist.root, 'human/dark/compact/en', '重新加载之后根元素上的样子')
  same(persist.ratio, 1.1, '重新加载之后页面是原来的几倍')
  same(persist.marked, 'human/dark/compact/1.1/en', '重新加载之后设置页里标着的')
  same(seen.kept, { skin: 'human', theme: 'dark', zoom: 1.1 }, '外壳记下来的外观')
  return failed
}

export interface ColdAll {
  born: { backdrop: string; zoom: number; minSize: [number, number] } | null
  backdropNow: string
  minSizeNow: number[]
  wanted: { backdrop: string; minSize: { width: number; height: number } }
  cold: ColdSeen
}

/** 冷启动：窗口一建出来就是上次选的皮肤、明暗和缩放 */
export function judgeCold(seen: ColdAll): string[] {
  const failed: string[] = []
  const same = (actual: unknown, expected: unknown, what: string) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failed.push(`${what}：${JSON.stringify(actual)}（应该是 ${JSON.stringify(expected)}）`)
    }
  }
  const { wanted, cold } = seen
  same(seen.born?.backdrop, wanted.backdrop, '窗口刚建出来时的底色')
  same(seen.born?.zoom, 1.1, '窗口刚建出来时的缩放')
  same(
    seen.born?.minSize,
    [wanted.minSize.width, wanted.minSize.height],
    '窗口刚建出来时最小的大小',
  )
  same(seen.backdropNow.toLowerCase().slice(0, 7), wanted.backdrop, '窗口现在的底色')
  same(seen.minSizeNow, [wanted.minSize.width, wanted.minSize.height], '窗口现在最小的大小')
  same(cold.root, 'human/dark/compact/zh-CN', '页面一加载完根元素上的样子')
  same(cold.backdrop, wanted.backdrop, '页面的底色（该和窗口的底色是同一个）')
  same(cold.ratio, 1.1, '页面是原来的几倍')
  same(cold.marked, 'human/dark/compact/1.1', '设置页里标着的')
  return failed
}
