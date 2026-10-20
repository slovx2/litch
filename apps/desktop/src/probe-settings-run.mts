// 设置页验收在主进程这一头的编排：页面里的脚本分几段送进去，中间夹着要主进程做的事
// （点应用菜单、改窗口大小、重新加载、读外壳记下来的那一份）。只对着模拟核心，由 scripts/check-settings.mjs 起两次外壳：
// 头一遍（settings）把设置页、外观、快捷键、关于、六套组合、缩放都量了，最后留下一份不是默认的外观；
// 第二遍（settings-cold）用同一份用户数据目录冷启动，看窗口一建出来是不是就按那一份来。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow, Menu, screen } from 'electron'
import { BACKDROPS, minSizeOf, readLook } from './look.mjs'
import { ABOUT_ITEM, SETTINGS_ITEM, ZOOM_ITEMS } from './menu.mjs'
import { installFilesKit } from './probe-files-kit.mjs'
import { sidePanel, termPanel } from './probe-files-room.mjs'
import { aboutSeen, backdropsSeen, coldSeen, keysSeen } from './probe-settings-about.mjs'
import { screensSeen, zoomLists } from './probe-settings-audit.mjs'
import {
  type FirstSeen,
  judgeCold,
  judgeFirst,
  type MenuKey,
  type ZoomSeen,
} from './probe-settings-judge.mjs'
import { installSettingsKit, type SettingsKit } from './probe-settings-kit.mjs'
import { controlsSeen, menuSeen, pageSeen, previewSeen } from './probe-settings-page.mjs'
import { passwordsRemoved, passwordsSeen, SEEDED_SEALED } from './probe-settings-passwords.mjs'
import { toolsSeen } from './probe-settings-tools.mjs'
import {
  innerSize,
  lookSet,
  persistSeen,
  sessionOpen,
  showSection,
  sizedTo,
  turnSeen,
  zoomNow,
} from './probe-settings-turn.mjs'
import { installTerminalKit } from './probe-terminal-kit.mjs'
import { sizeSeen } from './probe-terminal-size.mjs'
import type { SmokeHooks } from './smoke.mjs'

export type SettingsMode = 'settings' | 'settings-cold'

/** 一遍验收最多跑这么久。到点不死等：把走到哪一步、页面当时的样子报出来 */
const DEADLINE_MS: Record<SettingsMode, number> = { settings: 480_000, 'settings-cold': 90_000 }

/** 模拟核心里用的那几个会话（示例数据里的标题） */
const MOCK = {
  // 一打开就重新流一遍的那个：有工具调用、代码块、文件改动
  talk: '把运行时与 SSH 入口的启动拆开',
  // 闲着的一个，用来“先点开别的再点回来”
  other: '设备进程的转发开销基准',
  // 一打开就等着审批
  waiting: '聚合面：会话列表合并与复合游标',
}

/** 头一遍最后留下的外观：第二遍冷启动要看到的就是它 */
export const LEFT_LOOK = { skin: 'human', theme: 'dark', density: 'compact', zoom: 1.1 } as const

const steps: string[] = []
const started = Date.now()
const step = (name: string) => {
  steps.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${name}`)
}

async function inPage<T, A extends unknown[]>(
  window: BrowserWindow,
  probe: (...args: A) => Promise<T> | T,
  ...args: A
): Promise<T> {
  step(probe.name)
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
}

/** 给人看的截图：只在给了 LITCH_SETTINGS_SHOTS（一个目录）时存，平时不存 */
async function shot(window: BrowserWindow, name: string): Promise<void> {
  const dir = process.env.LITCH_SETTINGS_SHOTS
  if (!dir) return
  writeFileSync(join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG())
}

/** 应用菜单里带着键的每一项：是哪一项（标识或者角色）、键是什么 */
function menuKeys(): MenuKey[] {
  const found: MenuKey[] = []
  const walk = (menu: Menu) => {
    for (const item of menu.items) {
      if (item.submenu) walk(item.submenu)
      if (!item.accelerator) continue
      found.push({
        item: item.id ? `id:${item.id}` : `role:${(item.role ?? '').toLowerCase()}`,
        accelerator: item.accelerator,
        label: item.label,
      })
    }
  }
  const menu = Menu.getApplicationMenu()
  if (menu) walk(menu)
  return found
}

/** 缩放到一档，把窗口缩到这一档下允许的最小，量终端、对话区、文件树 */
async function zoomSeen(window: BrowserWindow, zoom: number, base: number): Promise<ZoomSeen> {
  await inPage(window, lookSet, { zoom }, base)
  const area = screen.getDisplayMatching(window.getBounds()).workAreaSize
  const wanted = minSizeOf(zoom, area)
  const [minWidth = 0, minHeight = 0] = window.getMinimumSize()
  window.setSize(minWidth, minHeight)
  const [contentWidth = 0, contentHeight = 0] = window.getContentSize()
  // 页面收到新的大小：样式的像素数是窗口里面的大小除以缩放倍数
  const expect = {
    width: Math.round(contentWidth / zoom),
    height: Math.round(contentHeight / zoom),
  }
  await inPage(window, sizedTo, expect.width, expect.height)
  const inner = await inPage(window, innerSize)
  await inPage(window, sessionOpen, MOCK.talk)
  await inPage(window, termPanel, true)
  const term = await inPage(window, sizeSeen, 'size', inner.width, inner.height)
  await inPage(window, termPanel, false)
  await inPage(window, sidePanel, true)
  const lists = await inPage(window, zoomLists, MOCK.talk)
  await shot(window, `zoom-${zoom}`)
  await inPage(window, sidePanel, false)
  return {
    zoom,
    ratio: Math.round((inner.ratio / base) * 1000) / 1000,
    minSize: [minWidth, minHeight],
    wantedMinSize: [wanted.width, wanted.height],
    // 屏幕放得下这一档的最小窗口时，页面里能用的地方不该比 100% 时的最小窗口小
    roomy: wanted.width >= Math.ceil(900 * zoom) && wanted.height >= Math.ceil(560 * zoom),
    inner: [inner.width, inner.height],
    term,
    lists,
  }
}

async function runFirst(window: BrowserWindow, hooks: SmokeHooks): Promise<FirstSeen> {
  const base = screen.getDisplayMatching(window.getBounds()).scaleFactor
  await inPage(window, installSettingsKit)
  const atStart = await inPage(window, innerSize)
  const page = await inPage(window, pageSeen)

  // 应用菜单：“设置…”“关于”，和“显示”里管缩放的三项
  step('应用菜单：设置')
  const settingsItem = hooks.menu(SETTINGS_ITEM)
  const settingsAt = await inPage(window, menuSeen)
  step('应用菜单：关于')
  const aboutItem = hooks.menu(ABOUT_ITEM)
  const aboutAt = await inPage(window, menuSeen)
  const zoomSteps: number[] = []
  for (const id of [ZOOM_ITEMS.in, ZOOM_ITEMS.out, ZOOM_ITEMS.out, ZOOM_ITEMS.reset]) {
    step(`应用菜单：${id}`)
    if (!hooks.menu(id)) zoomSteps.push(-1)
    else zoomSteps.push(await inPage(window, zoomNow, base))
  }

  const controls = await inPage(window, controlsSeen)
  await inPage(window, showSection, 'look')
  await shot(window, 'look')
  const preview = await inPage(window, previewSeen)
  const backdrops = await inPage(window, backdropsSeen)
  const keys = await inPage(window, keysSeen)
  await shot(window, 'keys')
  const about = await inPage(window, aboutSeen)
  await shot(window, 'about')
  const tools = await inPage(window, toolsSeen)
  // 已保存的密码：接在清除浏览数据之后量
  const passwords = {
    seen: await inPage(window, passwordsSeen, SEEDED_SEALED),
    removed: await (async () => {
      await shot(window, 'passwords')
      return inPage(window, passwordsRemoved)
    })(),
  }
  const turn = await inPage(window, turnSeen, MOCK.talk, MOCK.other)
  const screens = await inPage(window, screensSeen, { talk: MOCK.talk, waiting: MOCK.waiting })

  // 缩放到最小和最大：终端的行列数、对话区、文件树
  const [width = 0, height = 0] = window.getSize()
  await inPage(window, installTerminalKit)
  await inPage(window, installFilesKit)
  const zooms = [await zoomSeen(window, 0.8, base), await zoomSeen(window, 1.5, base)]
  await inPage(window, lookSet, { zoom: 1 }, base)
  window.setSize(width, height)

  // 重开还在：换成一份不是默认的外观（连语言），重新加载——地址里不带平时那个“语言是中文”的临时指定
  await inPage(window, lookSet, { ...LEFT_LOOK, lang: 'en' }, base)
  await inPage(window, showSection, 'look')
  await shot(window, 'look-left')
  step('重新加载')
  await hooks.load({})
  await inPage(window, installSettingsKit)
  const persist = await inPage(window, persistSeen, base)
  // 语言换回中文留给第二遍；别的留着
  await inPage(window, lookSet, { lang: 'zh-CN' }, base)
  return {
    base,
    pageRatio: atStart.ratio,
    page,
    menu: { settingsItem, settingsAt, aboutItem, aboutAt, zoomSteps },
    controls,
    preview,
    backdrops,
    keys,
    menuKeys: menuKeys(),
    about,
    tools,
    passwords,
    turn,
    screens,
    zooms,
    persist,
    // 外壳自己记下来的那一份（用户数据目录的 preferences.json）
    kept: readLook(app.getPath('userData')),
  }
}

async function run(
  window: BrowserWindow,
  mode: SettingsMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  if (mode === 'settings') {
    const seen = await runFirst(window, hooks)
    return [seen, judgeFirst(seen, hooks, process.platform)]
  }
  const base = screen.getDisplayMatching(window.getBounds()).scaleFactor
  const born = hooks.born()
  await inPage(window, installSettingsKit)
  const cold = await inPage(window, coldSeen, base)
  const seen = {
    born,
    backdropNow: window.getBackgroundColor(),
    minSizeNow: window.getMinimumSize(),
    wanted: {
      backdrop: BACKDROPS[LEFT_LOOK.skin][LEFT_LOOK.theme],
      minSize: minSizeOf(
        LEFT_LOOK.zoom,
        screen.getDisplayMatching(window.getBounds()).workAreaSize,
      ),
    },
    cold,
  }
  return [seen, judgeCold(seen)]
}

/** 到点还没跑完：走到哪一步、页面当时什么样（页面答得上来的话） */
async function overdue(window: BrowserWindow, mode: SettingsMode): Promise<string> {
  const page = await Promise.race([
    window.webContents
      .executeJavaScript(
        `(${(
          () =>
            (window as unknown as { __setKit?: SettingsKit }).__setKit?.where() ??
            '页面里还没装上验收的工具'
        ).toString()})()`,
        true,
      )
      .catch((error: unknown) => `页面问不到：${String(error)}`),
    new Promise<string>((done) => setTimeout(() => done('页面三秒没有应答'), 3000)),
  ])
  return `验收跑了 ${DEADLINE_MS[mode] / 1000} 秒还没完。走过的步骤：${steps.join(' → ')}。页面：${String(page)}`
}

export async function runSettingsChecks(
  window: BrowserWindow,
  mode: SettingsMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  let stop: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly [object, string[]]>((done) => {
    stop = setTimeout(() => {
      void overdue(window, mode).then((what) => done([{ steps }, [what]]))
    }, DEADLINE_MS[mode])
  })
  try {
    return await Promise.race([
      // 哪一步出了错：把走过的步骤带上，好知道是在哪
      run(window, mode, hooks).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}（走过的步骤：${steps.join(' → ')}）`)
      }),
      late,
    ])
  } finally {
    clearTimeout(stop)
  }
}
