// 侧栏验收在主进程这一头的编排：页面里的脚本分几段送进去，中间夹着要主进程做的事
// （改窗口大小、点应用菜单、把核心重启）。
// 对着模拟核心，由 scripts/smoke.mjs --sidebar 起（npm run check:sidebar，也排在 check:full 里）。
// 想看样子：给 LITCH_SIDEBAR_SHOTS 一个目录，量完之后把几个场景在六套皮肤明暗下各截一张存进去（不给就不截）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { SIDEBAR_ITEM } from './menu.mjs'
import { judgeTally, tallySeen } from './probe-sidebar.mjs'
import { cwdSeen, judgeCwd } from './probe-sidebar-cwd.mjs'
import { filterKept, filterSeen, filterTo } from './probe-sidebar-filter.mjs'
import { judgeFilter } from './probe-sidebar-filter-judge.mjs'
import { dragTo, frameSeen, keysSeen, sidebarBecame, sidePanel } from './probe-sidebar-frame.mjs'
import { hideNow, hideSeen, reloadSeen } from './probe-sidebar-hide.mjs'
import { type FrameChecks, judgeFrame } from './probe-sidebar-judge.mjs'
import { installSidebarKit, type SidebarKit } from './probe-sidebar-kit.mjs'
import { judgeNative, NATIVE_PARENT, NATIVE_TITLE, nativeSeen } from './probe-sidebar-native.mjs'
import type { SmokeHooks } from './smoke.mjs'

/** 模拟核心里用的那个会话（示例数据里的标题）：本机、docs-site 项目，闲着的 */
const SESSION = '远程设备安装指引'

/** 走到哪一步了。只记在内存里，没跑完的时候才报出去 */
const steps: string[] = []

async function inPage<T, A extends unknown[]>(
  window: BrowserWindow,
  probe: (...args: A) => Promise<T> | T,
  ...args: A
): Promise<T> {
  steps.push(probe.name)
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
}

/** 侧栏这个框：拖宽、键盘、收起展开、应用菜单、宽窄不同的窗口、和右边的侧面板并存 */
async function frameChecks(
  window: BrowserWindow,
  hooks: SmokeHooks,
): Promise<Omit<FrameChecks, 'reload'>> {
  const [width = 0, height = 0] = window.getSize()
  const [minWidth = 0] = window.getMinimumSize()
  /** 改窗口的宽度，返回页面里应该看到的宽度：页面要等收到它，再量 */
  const sized = (toWidth: number) => {
    window.setSize(toWidth, height)
    return window.getContentSize()[0] ?? 0
  }
  /** 点应用菜单里的“侧栏”，等页面跟上 */
  const viaMenu = async (open: boolean) => {
    steps.push(open ? '应用菜单：展开' : '应用菜单：收起')
    const found = hooks.menu(SIDEBAR_ITEM)
    return [found, await inPage(window, sidebarBecame, open)] as const
  }

  const start = await inPage(window, frameSeen)
  const dragged: number[] = []
  for (const target of [360, 2000, 0, 360]) dragged.push(await inPage(window, dragTo, target))
  const afterDrag = await inPage(window, frameSeen)
  const keys = await inPage(window, keysSeen)
  await inPage(window, dragTo, 360)
  const hide = await inPage(window, hideSeen, SESSION)
  const [menuFound, menuClosed] = await viaMenu(false)
  const [, menuOpened] = await viaMenu(true)

  const narrow = await inPage(window, frameSeen, sized(minWidth))
  const restored = await inPage(window, frameSeen, sized(width))

  // 窗口不宽不窄、右边的侧面板开着：侧栏一变，侧面板要跟着重新算
  const middle = sized(1100)
  await inPage(window, sidePanel, true)
  await inPage(window, dragTo, 300)
  const slim = await inPage(window, frameSeen, middle)
  await inPage(window, dragTo, 2000)
  const wide = await inPage(window, frameSeen, middle)
  await viaMenu(false)
  const hidden = await inPage(window, frameSeen, middle)
  await viaMenu(true)
  await inPage(window, sidePanel, false)
  await inPage(window, frameSeen, sized(width))
  await inPage(window, dragTo, 360)

  return {
    start,
    dragged,
    afterDrag,
    keys,
    hide,
    menuFound,
    menuClosed,
    menuOpened,
    narrow,
    restored,
    beside: { slim, wide, hidden },
    minWidth,
  }
}

/** 截图用的场景：什么都不动，都展开着（看得到工作目录的记号） */
async function scenePlain(): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  await kit.until('侧栏里的会话', () => kit.titles('build').length, 10_000)
}

/** 截图用的场景：把本机的 litch 和整台 build-01 收起来，行上带着汇总 */
async function sceneFolded(): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  await kit.fold(kit.workspaceLine('local', 'litch'), false)
  await kit.fold(kit.deviceLine('build'), false)
}

/** 截图用的场景：筛选的选项点开着（接着上一个：这时正只看 Pi） */
async function sceneChoices(): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  kit.one<HTMLButtonElement>('.sb-filter > .ibtn')?.click()
  await kit.until('筛选的选项', () => kit.one('.sb-filter .pick-pop'), 5000)
}

/** 截图用的场景：侧栏调到最窄 */
async function sceneSlim(): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const handle = kit.one('.sb-grip') as HTMLElement
  // 先把上一个场景点开的选项收掉
  kit.press(document.activeElement ?? handle, 'Escape')
  for (let count = 0; count < 12; count++) kit.press(handle, 'ArrowLeft')
  await kit.sleep(100)
}

/** 截图用的场景：侧栏收起，标题栏上多出“新对话” */
async function sceneHidden(): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  await kit.sleep(220)
  kit.one<HTMLButtonElement>('.tb-sidebar')?.click()
  await kit.sleep(100)
}

/** 截图之前换一套皮肤和明暗 */
async function wear(skin: string, theme: string): Promise<void> {
  ;(
    window as unknown as { __litchLook: { set(patch: { skin: string; theme: string }): void } }
  ).__litchLook.set({ skin, theme })
  await new Promise<void>((done) => setTimeout(done, 250))
}

/** 一个接一个摆：后一个场景是在前一个的样子上接着摆的 */
const SCENES: [name: string, arrange: (window: BrowserWindow) => Promise<void>][] = [
  ['plain', (window) => inPage(window, scenePlain)],
  ['folded', (window) => inPage(window, sceneFolded)],
  ['filter', (window) => inPage(window, filterTo, 'pi')],
  ['choices', (window) => inPage(window, sceneChoices)],
  ['slim', (window) => inPage(window, sceneSlim)],
  ['hidden', (window) => inPage(window, sceneHidden)],
]

async function shoot(window: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  for (const [name, arrange] of SCENES) {
    await arrange(window)
    for (const skin of ['retro', 'human', 'standard']) {
      for (const theme of ['light', 'dark']) {
        await inPage(window, wear, skin, theme)
        const image = await window.webContents.capturePage()
        writeFileSync(join(dir, `${name}-${skin}-${theme}.png`), image.toPNG())
      }
    }
  }
}

async function run(window: BrowserWindow, hooks: SmokeHooks): Promise<readonly [object, string[]]> {
  await inPage(window, installSidebarKit)
  const tally = await inPage(window, tallySeen)
  const frame = await frameChecks(window, hooks)
  const filter = await inPage(window, filterSeen, SESSION)
  const cwd = await inPage(window, cwdSeen)
  const native = await inPage(window, nativeSeen, NATIVE_TITLE)

  // 只看着 Pi、侧栏收着的时候把核心杀掉：外壳会把它重新拉起来、让窗口重新加载，和应用重开差不多
  await inPage(window, filterTo, 'pi')
  await inPage(window, hideNow)
  const reloaded = new Promise<void>((done) => {
    window.webContents.once('did-finish-load', () => done())
  })
  steps.push('重启核心')
  hooks.restartCore()
  await reloaded
  await inPage(window, installSidebarKit)
  const reload = await inPage(window, reloadSeen)
  const kept = await inPage(window, filterKept)

  const shots = process.env.LITCH_SIDEBAR_SHOTS
  if (shots) await shoot(window, shots)
  return [
    { tally, frame: { ...frame, reload }, filter, kept, cwd, native },
    [
      ...judgeTally(tally),
      ...judgeFrame({ ...frame, reload }),
      ...judgeFilter(filter, kept, SESSION),
      ...judgeCwd(cwd),
      ...judgeNative(native, NATIVE_PARENT),
    ],
  ]
}

export async function runSidebarChecks(
  window: BrowserWindow,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  try {
    return await run(window, hooks)
  } catch (error) {
    // 哪一步出了错：把走过的步骤带上，好知道是在哪
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}（走过的步骤：${steps.join(' → ')}）`)
  }
}
