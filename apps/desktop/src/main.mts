// 主进程：只管窗口、生命周期，以及给窗口和核心之间牵一条消息端口。
// 它不解析协议，不持有会话状态，不在数据路径上。
// 唯一的例外是客户端工具（内置浏览器、Computer Use）：核心把模型的工具调用交给这里登记的执行器（client-tools/），
// 经手的只有那一次调用的参数和结果。
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { UPDATE_FEED_URL, type UpdateState } from '@litch/core'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
  type UtilityProcess,
  utilityProcess,
} from 'electron'
import { openLicenses } from './about.mjs'
import { type InstalledBrowser, installBrowser } from './browser/install.mjs'
import { createClientToolHost } from './client-tools/host.mjs'
import { showMachineNotice } from './client-tools/notice.mjs'
import { createExecutors } from './client-tools/registry.mjs'
import { CLIENT_TOOL, type ClientToolToMain } from './client-tools/types.mjs'
import { createComputerUse, locateHelper } from './computer-use/index.mjs'
import { createComputerUseSettings, fakePermissions } from './computer-use/settings.mjs'
import { createConfigMain } from './config-main.mjs'
import {
  ABOUT,
  ATTACH,
  COMPUTER_USE_APPS,
  COMPUTER_USE_FORGET_APP,
  COMPUTER_USE_OPEN_SETTINGS,
  COMPUTER_USE_RESTART,
  COMPUTER_USE_STATUS,
  CORE_PORT,
  LANGUAGE,
  LICENSE_TEXT,
  MENU,
  NOTIFY,
  NOTIFY_CLICK,
  OPEN_EXTERNAL,
  PICK_FOLDER,
  REQUEST_CORE_PORT,
  SERVICE,
  SET_LANGUAGE,
  SET_LOOK,
  TERMINALS,
  UPDATE_CHECK,
  UPDATE_GET,
  UPDATE_INSTALL,
  UPDATE_SET_AUTO,
  UPDATE_STATE,
} from './ipc.mjs'
import {
  bundledAdapter,
  defaultAdapterHome,
  serviceEnv,
  stopDevice,
  stopIdleDevice,
} from './local-adapter.mjs'
import { loginEnvironment } from './login-env.mjs'
import {
  backdropOf,
  DEFAULT_LOOK,
  MIN_SIZE,
  minSizeOf,
  parseLook,
  readLook,
  type ShellLook,
  writeLook,
} from './look.mjs'
import { MANUAL_SET_ENABLED, MANUAL_STATUS } from './manual-ipc.mjs'
import { createManualSkill } from './manual-skill.mjs'
import { installMenu, type MenuLang } from './menu.mjs'
import { readPreferences, writePreference } from './preferences.mjs'
import {
  askServiceBeforeQuit,
  readServiceQuitChoice,
  type ServiceQuitOutcome,
  stopServiceOnQuit,
  writeServiceQuitChoice,
} from './quit-service.mjs'
import {
  type AliveCount,
  type QuitOutcome,
  readQuitChoice,
  settleTerminalsBeforeQuit,
  writeQuitChoice,
} from './quit-terminals.mjs'
import { runShots } from './shots.mjs'
import { MOCK_MODES, runSmoke, SMOKE_MODES, type SmokeMode } from './smoke.mjs'
import { parseTaskNotice, showTaskNotice } from './task-notice.mjs'
import { createUpdater, type Updater, updatePlatform } from './updater.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
/** 界面的构建产物在哪。开发时直接用界面包的产物目录；装成应用后界面跟外壳放在一起（见 scripts/pack.mjs） */
const uiRoot = normalize(join(here, app.isPackaged ? '../ui' : '../../../packages/ui/dist'))
// 图标：开发时就在外壳的 assets 目录里，打包时 pack.mjs 把用得着的那一张放在同样的相对位置上
const assetsDir = normalize(join(here, '../assets'))
/** 设了就从界面的开发服务器加载，改界面不用重启外壳 */
const devUrl = process.env.LITCH_UI_URL
/** 自检的方式，见 smoke.mts。没设就是正常运行 */
const smokeMode = SMOKE_MODES.includes(process.env.LITCH_SMOKE ?? '')
  ? (process.env.LITCH_SMOKE as SmokeMode)
  : undefined
/** 设了就是给 README 截图：截完存到这个目录里就退出，见 shots.mts */
const shotsDir = process.env.LITCH_SHOTS
/** 自检和截图都不显示窗口、不抢单实例锁 */
const smoke = smokeMode !== undefined || shotsDir !== undefined
/**
 * 指定了就不看系统和上次的选择，界面和示例数据都用这种语言。自检固定用中文：
 * 验收脚本是按中文的会话标题去点的，不能跟着机器的语言变。
 */
const forcedLang: 'zh-CN' | 'en' | undefined =
  process.env.LITCH_LANG === 'en' || process.env.LITCH_LANG === 'zh-CN'
    ? process.env.LITCH_LANG
    : smoke
      ? 'zh-CN'
      : undefined
/** 外观上的临时指定，原样交给界面。LITCH_SKIN、LITCH_THEME 是给开发时换着皮肤跑自检用的 */
const forcedLook: Record<string, string> = {
  ...(forcedLang ? { lang: forcedLang } : {}),
  ...(process.env.LITCH_SKIN ? { skin: process.env.LITCH_SKIN } : {}),
  ...(process.env.LITCH_THEME ? { theme: process.env.LITCH_THEME } : {}),
}
/**
 * 自检和截图由启动它们的脚本给一份临时的用户数据目录，跑完删掉：
 * 它们会写草稿、存外观的选择，不能落进平时用的那一份里。这一句必须在应用就绪之前执行
 */
if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)
// 开发时对着模拟核心跑（client:start:mock）没给目录的，用一份自己的，和平时那份分开：
// 模拟核心的设备配置、侧栏快照、外观的选择都不该落进平时用的那一份
else if (process.env.LITCH_MOCK) app.setPath('userData', `${app.getPath('userData')} Mock`)
/**
 * 应用自带的适配器在哪，交给核心去启动和连接（见 local-adapter.mts）。空的就是没有。
 * 装好的应用里它在 Resources/adapter（scripts/pack.mjs 放进去的）；开发时用 LITCH_ADAPTER_ROOT
 * 指到一份暂存好的目录。
 * 自检和截图除非明说了状态目录（LITCH_ADAPTER_HOME），否则一律当作没有：
 * 默认的状态目录是用户平时在用的那一份，自检不许去碰它。
 */
const adapterRoot =
  smoke && !process.env.LITCH_ADAPTER_HOME
    ? ''
    : (process.env.LITCH_ADAPTER_ROOT ??
      (app.isPackaged ? join(process.resourcesPath, 'adapter') : ''))
const UI_ORIGIN = 'app://ui'
/**
 * 产品手册（manual-skill.mts）：启动时装进本机各 harness 的技能目录。源文件在装好的应用里随内置适配器放在
 * adapter/skills 下（scripts/stage-adapter.mjs），开发时直接用仓库里的。自检和截图不装：它们不许碰用户的主目录
 */
const manualSkill = createManualSkill({
  dataDir: app.getPath('userData'),
  version: app.getVersion(),
  source:
    smoke || !adapterRoot
      ? null
      : app.isPackaged
        ? join(adapterRoot, 'skills', 'litch-manual')
        : normalize(join(here, '../../../skills/litch-manual')),
  adapterBin: smoke || !adapterRoot ? null : bundledAdapter(adapterRoot).bin,
  ...(smoke ? { reason: 'Self-check runs do not install the manual' } : {}),
  platform: process.platform,
  home: homedir(),
  environment: () => loginEnvironment(),
  log: (line) => console.error(`[manual] ${line}`),
})

// 界面从自己的协议加载，不用 file://：这样它有一个正常的来源，内容安全策略里的 'self' 才成立，
// 页面也碰不到安装目录之外的文件。这一句必须在应用就绪之前执行。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

function serveUi(request: Request): Response | Promise<Response> {
  const url = new URL(request.url)
  if (url.host !== 'ui') return new Response('not found', { status: 404 })
  const path = decodeURIComponent(url.pathname)
  const file = normalize(join(uiRoot, path === '/' ? 'index.html' : path))
  // 不许走出界面的产物目录
  if (!file.startsWith(uiRoot + sep)) return new Response('forbidden', { status: 403 })
  return net.fetch(pathToFileURL(file).toString())
}

/** 界面的地址。params 是外观上的临时指定（语言、皮肤、明暗），界面优先用它，但不会记下来 */
export function uiUrl(params: Record<string, string>): string {
  const url = new URL(devUrl ?? `${UI_ORIGIN}/index.html`)
  // 自检和截图用的是临时的用户数据目录，每次都像第一次启动：首启引导一律不出，
  // 只有专门验它的那一项（LITCH_ONBOARDING=1）让它出
  if (smoke && process.env.LITCH_ONBOARDING !== '1') url.searchParams.set('onboarding', 'off')
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url.toString()
}

const isUiUrl = (url: string): boolean =>
  devUrl ? url.startsWith(devUrl) : url.startsWith(`${UI_ORIGIN}/`)

let core: UtilityProcess | null = null
/** 内置浏览器。它的 executor 交给客户端工具的执行器登记表（命名空间 litch_browser） */
export let browser: InstalledBrowser | null = null
let quitting = false

/**
 * 客户端工具的执行器（client-tools/registry.mts 里登记的，这台桌面上用得了的那几个）。核心发来的调用交给它们，
 * 结果和要用户点头的卡片发回给现在的核心
 */
/**
 * Computer Use（macOS 和 Windows）：macOS 上系统权限授给单独签名的助手应用，Windows 上助手是 Litch 起的子进程；
 * 都是用到时才拉起（computer-use/index.mts）。界面语言变了告诉它（屏幕提示跟着换），退出前收掉
 */
const computerUse =
  process.platform === 'darwin' || process.platform === 'win32'
    ? createComputerUse({
        platform: process.platform,
        userData: app.getPath('userData'),
        helperPath: locateHelper({
          platform: process.platform,
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        }),
        version: app.isPackaged ? app.getVersion() : null,
        lang: forcedLang ?? (app.getLocale().startsWith('zh') ? 'zh-CN' : 'en'),
        log: (line) => console.error(`[computer-use] ${line}`),
      })
    : null
const clientTools = createClientToolHost(
  [
    ...createExecutors({
      platform: process.platform,
      env: process.env,
      log: (line) => console.error(`[client-tools] ${line}`),
    }),
    ...(computerUse ? [computerUse.executor] : []),
  ],
  (message) => core?.postMessage(message),
)
/** 核心连续几次刚起来就退出了。用来拉开重启的间隔，免得出错时原地打转 */
let quickExits = 0

function startCore(): void {
  const startedAt = Date.now()
  const child = utilityProcess.fork(join(here, 'core-host.mjs'), [], {
    serviceName: 'Litch core',
    env: {
      ...process.env,
      LITCH_VERSION: app.getVersion(),
      // 设备配置和侧栏快照存在用户数据目录里
      LITCH_DATA_DIR: app.getPath('userData'),
      LITCH_ADAPTER_ROOT: adapterRoot,
      // 示例数据的语言：没指定就跟系统
      LITCH_LANG: forcedLang ?? (app.getLocale().startsWith('zh') ? 'zh-CN' : 'en'),
      // 对着模拟核心自检时不连任何设备
      ...(MOCK_MODES.includes(smokeMode ?? '') || shotsDir ? { LITCH_MOCK: '1' } : {}),
    },
  })
  core = child
  // 先告诉核心这台桌面能执行哪些客户端工具：它等这一句再去连设备，握手时照着声明
  child.postMessage({ type: CLIENT_TOOL, op: 'namespaces', namespaces: clientTools.namespaces() })
  // 核心往回发两种消息：客户端工具的调用和答复；退出前问它终端的事，它的回答
  child.on('message', (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type === CLIENT_TOOL) {
      if (core !== child) return
      const tool = message as ClientToolToMain
      // litch_machine 找不到会话的卡片进了全局待处理：发一条系统通知（08 号 4.2），点了把窗口叫到前面
      if (tool.op === 'notify') {
        const lang = menuLang ?? forcedLang ?? (app.getLocale().startsWith('zh') ? 'zh-CN' : 'en')
        showMachineNotice(tool.notice, lang, () => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        })
        return
      }
      // litch config 里属于主进程的一项（config-main.mts）：做完把结果交回核心
      if (tool.op === 'config') {
        void configMain(tool.request).then((result) => {
          if (core === child) {
            child.postMessage({ type: CLIENT_TOOL, op: 'configResult', id: tool.id, result })
          }
        })
        return
      }
      clientTools.handle(tool)
      return
    }
    const service = message as { type?: unknown; id?: unknown; stoppable?: unknown } | null
    if (service?.type === SERVICE && typeof service.id === 'number') {
      serviceWaiting.get(service.id)?.(service.stoppable === true)
      return
    }
    const data = message as { type?: unknown; id?: unknown; alive?: AliveCount } | null
    if (data?.type !== TERMINALS || typeof data.id !== 'number') return
    askWaiting.get(data.id)?.(data.alive ?? null)
  })
  child.on('exit', (code) => {
    if (core === child) core = null
    // 核心没了：它交来的调用都不用做了，卡片都当作没答
    clientTools.reset()
    if (quitting) return
    // 核心意外退出：重新拉起，并让所有窗口重新加载，它们会各自再要一个端口
    quickExits = Date.now() - startedAt < 30_000 ? quickExits + 1 : 0
    const delay = quickExits === 0 ? 0 : Math.min(500 * 2 ** (quickExits - 1), 10_000)
    console.error(`核心进程退出了（退出码 ${code}），${delay} 毫秒后重新启动`)
    setTimeout(() => {
      if (quitting) return
      startCore()
      for (const window of BrowserWindow.getAllWindows()) window.webContents.reload()
    }, delay)
  })
}

// ---------- 外观里要外壳来办的：窗口的底色、页面的缩放、窗口最小多大（look.mts） ----------

/**
 * 现在按哪一份外观办。启动时是上次记下来的（地址里临时指定了皮肤、明暗的，这一次按指定的来），
 * 界面起来之后每次报过来就换成它报的
 */
let look: ShellLook = DEFAULT_LOOK
/** 用环境变量临时指定了皮肤或明暗的这一次，界面报来的外观不往下记：那不是用户选的 */
const keepLook = !process.env.LITCH_SKIN && !process.env.LITCH_THEME
/** 窗口刚建出来时用的底色、缩放、最小的大小。设置页的验收拿它对“冷启动直接是上次选的” */
let born: { backdrop: string; zoom: number; minSize: [number, number] } | null = null

/** 屏幕上能放窗口的地方有多大。window 给了就看它所在的那块屏幕 */
const workArea = (window?: BrowserWindow) =>
  (window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay()).workAreaSize

/** 让一个窗口照现在这份外观来：底色、缩放、最小的大小 */
function dressWindow(window: BrowserWindow): void {
  const contents = window.webContents
  if (Math.abs(contents.getZoomFactor() - look.zoom) > 0.001) contents.setZoomFactor(look.zoom)
  const least = minSizeOf(look.zoom, workArea(window))
  window.setMinimumSize(least.width, least.height)
  const [width = 0, height = 0] = window.getSize()
  // 改最小的大小不会把已经比它小的窗口撑开，这里自己撑
  if (width < least.width || height < least.height) {
    window.setSize(Math.max(width, least.width), Math.max(height, least.height))
  }
  window.setBackgroundColor(backdropOf(look, nativeTheme.shouldUseDarkColors))
}

function createWindow(): BrowserWindow {
  const least = minSizeOf(look.zoom, workArea())
  const backdrop = backdropOf(look, nativeTheme.shouldUseDarkColors)
  born = { backdrop, zoom: look.zoom, minSize: [least.width, least.height] }
  const window = new BrowserWindow({
    // 截图用固定的尺寸
    width: Math.max(shotsDir ? 1280 : 1360, least.width),
    height: Math.max(shotsDir ? 800 : 860, least.height),
    minWidth: least.width,
    minHeight: least.height,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Linux 上窗口不会自己从可执行文件上取图标，要给；macOS 和 Windows 用的是应用自己的
    ...(process.platform === 'linux' ? { icon: join(assetsDir, 'icon.png') } : {}),
    // 页面画出来之前窗口的底色：上次选的皮肤和明暗下内容面的颜色，免得先闪一下白或者闪一下别的皮肤
    backgroundColor: backdrop,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !smoke,
      // 页面一开始就按上次的倍数缩放，不等界面起来再报
      zoomFactor: look.zoom,
    },
  })
  // 界面不开新窗口，也不跳到别的地址
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isUiUrl(url)) event.preventDefault()
  })
  if (!smoke) window.once('ready-to-show', () => window.show())
  void window.loadURL(uiUrl(forcedLook))
  return window
}

// 牵线：界面要端口时，新开一对端口，一头给核心，一头给界面。之后两边直接对话
ipcMain.on(REQUEST_CORE_PORT, (event) => {
  const frame = event.senderFrame
  if (!core || !frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage({ type: ATTACH }, [port1])
  event.sender.postMessage(CORE_PORT, null, [port2])
})

// 回答里的链接交给系统的浏览器。只接受界面自己的主框架发来的、http 或 https 的网址
ipcMain.on(OPEN_EXTERNAL, (event, url: unknown) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return
  if (typeof url !== 'string') return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  void shell.openExternal(parsed.toString())
})

// 定时任务跑完了的系统通知：要不要发、说什么由界面定，这里只认界面自己的主框架发来的、形状对的那一条
ipcMain.on(NOTIFY, (event, value: unknown) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return
  const notice = parseTaskNotice(value)
  if (notice) showTaskNotice(notice, event.sender, NOTIFY_CLICK)
})

// 界面的外观是用户在界面里选的，存在界面那边：它启动时和每次改的时候报一声。
// 缩放这里照办；三样都记一份，下次冷启动、页面还没起来的时候窗口先按它们来
ipcMain.on(SET_LOOK, (event, value: unknown) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return
  const next = parseLook(value)
  if (!next) return
  const changed = next.skin !== look.skin || next.theme !== look.theme || next.zoom !== look.zoom
  look = next
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window) dressWindow(window)
  if (!changed || !keepLook) return
  try {
    writeLook(app.getPath('userData'), next)
  } catch (error) {
    // 记不下来只影响下次冷启动头一眼的底色，不值得打断人
    console.error(`没能记下外观：${String(error)}`)
  }
})

// 明暗跟随系统的时候，系统换了深浅，窗口的底色跟着换（拖大窗口时露出来的就是它）
nativeTheme.on('updated', () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(backdropOf(look, nativeTheme.shouldUseDarkColors))
  }
})

// ---------- “关于”那一页：版本和许可文本（about.mts） ----------

/**
 * 应用里带着的许可文本。装好的应用里在资源目录的 licenses 下；没打包时逐包的文本没有收，
 * 只有仓库根目录里本项目自己的两份。LITCH_LICENSES_DIR 是给自检用的：指到一份收好的目录
 */
let licenses: ReturnType<typeof openLicenses> | null = null
const licensesNow = () => {
  licenses ??= openLicenses(
    app.name,
    process.env.LITCH_LICENSES_DIR ||
      (app.isPackaged ? join(process.resourcesPath, 'licenses') : null),
    app.isPackaged ? null : normalize(join(here, '../../..')),
  )
  return licenses
}

ipcMain.handle(ABOUT, (event) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return null
  return {
    name: app.name,
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    ...licensesNow().shelf,
  }
})

ipcMain.handle(LICENSE_TEXT, (event, id: unknown) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return null
  return typeof id === 'string' ? licensesNow().text(id) : null
})

// ---------- 添加项目时选目录 ----------

/**
 * 系统的选文件夹对话框，挂在发请求的那个窗口上。defaultPath 是框里已经填了的（从那里开始找）；
 * 选了回绝对路径，取消回 null。LITCH_PICK_FOLDER 是给自检用的：不弹框，直接当作选了这个目录
 */
ipcMain.handle(PICK_FOLDER, async (event, options: unknown) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return null
  if (process.env.LITCH_PICK_FOLDER !== undefined) return process.env.LITCH_PICK_FOLDER || null
  const asked = (options ?? {}) as { defaultPath?: unknown; title?: unknown }
  const window = BrowserWindow.fromWebContents(event.sender)
  const settings: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    ...(typeof asked.title === 'string' ? { title: asked.title, message: asked.title } : {}),
    ...(typeof asked.defaultPath === 'string' && isAbsolute(asked.defaultPath)
      ? { defaultPath: asked.defaultPath }
      : {}),
  }
  const result = window
    ? await dialog.showOpenDialog(window, settings)
    : await dialog.showOpenDialog(settings)
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

// ---------- 设置页里 Computer Use 那一节（macOS 和 Windows 上有，computer-use/settings.mts） ----------

/**
 * macOS：两项系统权限的状态、打开系统设置对应的那一页；Windows：助手的状态。两边都有重启助手、“始终允许”的清单。
 * 只接受界面自己的主框架发来的；预加载脚本也只在这两个平台上给界面这一组接口
 */
const computerUseSettings = computerUse
  ? createComputerUseSettings(
      {
        platform: computerUse.platform,
        permissions: () => computerUse.permissions(),
        helperInfo: (launch) => computerUse.helperInfo(launch),
        lastError: () => computerUse.supervisor.lastError,
        running: () => computerUse.supervisor.connected !== null,
        openPermissionSettings: (pane) => computerUse.openPermissionSettings(pane),
        restartHelper: () => computerUse.restartHelper(),
        listAlwaysAllowed: () => computerUse.listAlwaysAllowed(),
        removeAlwaysAllowed: (bundleId) => computerUse.removeAlwaysAllowed(bundleId),
      },
      // 自检和截图一律不去拉起真的助手：没指定假权限时当作两项都没给
      fakePermissions(process.env.LITCH_COMPUTER_USE_PERMISSIONS ?? (smoke ? 'none' : undefined)),
    )
  : null

/** litch config 里只有主进程做得了的几项：内置浏览器的网站和数据、Computer Use（config-main.mts） */
const configMain = createConfigMain({ browser: () => browser, computer: computerUseSettings })
const fromUi = (event: Electron.IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame
  return !!frame && frame === event.sender.mainFrame && isUiUrl(frame.url)
}
ipcMain.handle(COMPUTER_USE_STATUS, (event, launch: unknown) =>
  fromUi(event) && computerUseSettings ? computerUseSettings.status(launch === true) : null,
)
ipcMain.handle(COMPUTER_USE_OPEN_SETTINGS, (event, pane: unknown) =>
  fromUi(event) && computerUseSettings ? computerUseSettings.openSettings(pane) : false,
)
ipcMain.handle(COMPUTER_USE_RESTART, (event) =>
  fromUi(event) && computerUseSettings ? computerUseSettings.restart() : null,
)
ipcMain.handle(COMPUTER_USE_APPS, (event) =>
  fromUi(event) && computerUseSettings ? computerUseSettings.apps() : [],
)
ipcMain.handle(COMPUTER_USE_FORGET_APP, (event, bundleId: unknown) =>
  fromUi(event) && computerUseSettings ? computerUseSettings.forgetApp(bundleId) : false,
)

// 产品手册：设置页“配置助手”一节的状态和开关（manual-skill.mts，形状在 manual-ipc.mts）
ipcMain.handle(MANUAL_STATUS, (event) => (fromUi(event) ? manualSkill.status() : null))
ipcMain.handle(MANUAL_SET_ENABLED, (event, on: unknown) =>
  fromUi(event) && typeof on === 'boolean' ? manualSkill.setEnabled(on) : null,
)

// ---------- 应用自己的更新（updater.mts） ----------

/**
 * 只在装好的应用里查；LITCH_UPDATE_FEED 换成本机的假清单时没打包也查（开发、验收用，允许 http）。
 * 自检和截图一律不查。应用就绪后才建出来
 */
let updater: Updater | null = null
const updateFeedOverride = process.env.LITCH_UPDATE_FEED
/** 设置里“自动检查更新”的开关，存在外壳的偏好里，默认开 */
const AUTO_UPDATE_KEY = 'autoUpdate'
const autoUpdateOn = () => readPreferences(app.getPath('userData'))[AUTO_UPDATE_KEY] !== false
/** Windows：这一次退出是点了“重启以更新”，装完要把应用再打开 */
let relaunchAfterInstall = false

function createAppUpdater(): Updater | null {
  if (smoke || (!app.isPackaged && !updateFeedOverride)) return null
  return createUpdater({
    version: app.getVersion(),
    platform: updatePlatform(),
    dataDir: app.getPath('userData'),
    feedUrl: updateFeedOverride || UPDATE_FEED_URL,
    allowHttp: !!updateFeedOverride,
    auto: autoUpdateOn,
    onState(state: UpdateState) {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send(UPDATE_STATE, state)
    },
    log: (line) => console.error(`[update] ${line}`),
  })
}

const updateView = () => ({
  supported: updater !== null && updatePlatform() !== null,
  auto: autoUpdateOn(),
  state: updater?.state() ?? ({ phase: 'idle' } as UpdateState),
})
ipcMain.handle(UPDATE_GET, (event) => (fromUi(event) ? updateView() : null))
ipcMain.handle(UPDATE_CHECK, async (event) => {
  if (!fromUi(event) || !updater) return null
  await updater.check()
  return updateView()
})
ipcMain.handle(UPDATE_SET_AUTO, (event, on: unknown) => {
  if (!fromUi(event) || typeof on !== 'boolean') return null
  writePreference(app.getPath('userData'), AUTO_UPDATE_KEY, on)
  return updateView()
})
// 点了“重启以更新”：退出前的规矩照旧（还有终端在跑就问一声），点了“不退了”就什么都不做
ipcMain.handle(UPDATE_INSTALL, async (event) => {
  if (!fromUi(event) || updater?.state().phase !== 'ready') return false
  const outcome = await settleQuit().catch(
    (): QuitOutcome => ({ proceed: true, alive: null, asked: false, did: 'none' }),
  )
  if (!outcome.proceed) return false
  quitSettled = true
  if (process.platform === 'darwin') {
    // 它会先关窗口，再走 before-quit（这时已经问过，直接把核心停掉）
    updater.quitAndInstall()
  } else {
    relaunchAfterInstall = true
    app.quit()
  }
  return true
})

/**
 * Windows：退出时有下好的安装程序就装。新版本要换掉内置适配器的文件，常驻的设备服务正用着它们，
 * 所以先请服务闲着的话停下（有回合、终端在跑就不停，这一次不装，下次退出再说，免得把用户的活儿打断）。
 * 核心刚被结束，它和服务之间的连接可能还没断干净，服务会因此说自己忙：隔一会儿再问，问三次。
 * 返回装没装
 */
async function installOnQuit(installer: string): Promise<boolean> {
  if (adapterRoot) {
    const adapter = bundledAdapter(adapterRoot)
    const home = process.env.LITCH_ADAPTER_HOME || defaultAdapterHome()
    const env = serviceEnv(menuLang ?? 'en', null)
    for (let attempt = 1; ; attempt++) {
      const stop = await stopIdleDevice(adapter, home, env, new AbortController().signal, 15_000)
      if (stop.kind === 'stopped') break
      if (stop.kind === 'busy' && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      console.error(`[update] 设备服务没停（${stop.kind}），这次不装，下次退出再装`)
      return false
    }
  }
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']
  if (relaunchAfterInstall) args.push('/LITCHRELAUNCH')
  spawn(installer, args, { detached: true, stdio: 'ignore' }).unref()
  return true
}

let installingOnQuit = false
app.on('will-quit', (event) => {
  const installer = process.platform === 'win32' ? updater?.installer() : null
  if (!installer || installingOnQuit) return
  event.preventDefault()
  installingOnQuit = true
  void installOnQuit(installer)
    .catch((error: unknown) => {
      console.error(`[update] 拉起安装程序失败：${String(error)}`)
      return false
    })
    .then((installed) => {
      // 点了“重启以更新”却没装成：照样把应用重新打开，下好的安装程序留着，下次退出再装
      if (!installed && relaunchAfterInstall) app.relaunch()
      app.exit(0)
    })
})

/**
 * 用户选了退出时一起关后台服务：核心已经结束，再请服务停下（忙的话问一声，quit-service.mts）。
 * Windows 上有下好的安装程序时由 installOnQuit 去停，这里不管
 */
let stoppingServiceOnQuit = false
app.on('will-quit', (event) => {
  if (!stopServiceAfterQuit || stoppingServiceOnQuit || !adapterRoot) return
  if (process.platform === 'win32' && updater?.installer()) return
  event.preventDefault()
  stoppingServiceOnQuit = true
  const adapter = bundledAdapter(adapterRoot)
  const home = process.env.LITCH_ADAPTER_HOME || defaultAdapterHome()
  const lang = menuLang ?? 'en'
  const env = serviceEnv(lang, null)
  void stopServiceOnQuit({
    lang,
    stop: (ifIdle) => stopDevice(adapter, home, env, new AbortController().signal, ifIdle),
    ...(serviceBusyAnswer
      ? { answer: serviceBusyAnswer }
      : smoke
        ? { answer: 'keep' as const }
        : {}),
    log: (line) => console.error(`[service] ${line}`),
  })
    .catch((error: unknown) => console.error(`[service] 关后台服务失败：${String(error)}`))
    .then(() => app.exit(0))
})

// ---------- 退出之前：还有终端在运行的话问一声（quit-terminals.mts） ----------

let askSeq = 0
const askWaiting = new Map<number, (alive: AliveCount | null) => void>()

/** 问核心终端的事：数一数（count），或者都结束（end）。核心没了、到点没答，都是 null */
function askCore(op: 'count' | 'end', timeoutMs: number): Promise<AliveCount | null> {
  const child = core
  if (!child) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = ++askSeq
    const timer = setTimeout(() => {
      askWaiting.delete(id)
      resolve(null)
    }, timeoutMs)
    askWaiting.set(id, (alive) => {
      clearTimeout(timer)
      askWaiting.delete(id)
      resolve(alive)
    })
    child.postMessage({ type: TERMINALS, id, op })
  })
}

/** 自检时不弹窗，用这里给的回答（leave、end、cancel） */
const quitAnswer = ['leave', 'end', 'cancel'].includes(process.env.LITCH_QUIT_TERMINALS ?? '')
  ? (process.env.LITCH_QUIT_TERMINALS as 'leave' | 'end' | 'cancel')
  : undefined

/** answer：不弹窗，直接当作用户点了这一项。验收用 */
function settleQuit(answer = quitAnswer): Promise<QuitOutcome> {
  const dataDir = app.getPath('userData')
  return settleTerminalsBeforeQuit({
    lang: menuLang ?? 'en',
    count: () => askCore('count', 1500),
    async end() {
      await askCore('end', 5000)
    },
    choice: () => readQuitChoice(dataDir),
    remember(choice) {
      writeQuitChoice(dataDir, choice)
      refreshMenu()
    },
    window: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    // 自检不弹窗；没给回答的自检按“留着”算，免得卡在一个看不见的对话框上
    ...(answer ? { answer } : smoke ? { answer: 'leave' as const } : {}),
  })
}

// ---------- 退出之前：后台服务要不要一起关（quit-service.mts） ----------

const serviceWaiting = new Map<number, (stoppable: boolean) => void>()

/** 问核心本机连着的是不是 device-start 拉起的服务。核心没了、到点没答，都当作不是 */
function askCoreService(timeoutMs: number): Promise<boolean> {
  const child = core
  if (!child) return Promise.resolve(false)
  return new Promise((resolve) => {
    const id = ++askSeq
    const timer = setTimeout(() => {
      serviceWaiting.delete(id)
      resolve(false)
    }, timeoutMs)
    serviceWaiting.set(id, (stoppable) => {
      clearTimeout(timer)
      serviceWaiting.delete(id)
      resolve(stoppable)
    })
    child.postMessage({ type: SERVICE, id })
  })
}

/** 自检时不弹窗，用这里给的回答：退出时问的那一下（keep、stop、cancel），服务忙时问的那一下（force、keep） */
const serviceAnswer = ['keep', 'stop', 'cancel'].includes(process.env.LITCH_QUIT_SERVICE ?? '')
  ? (process.env.LITCH_QUIT_SERVICE as 'keep' | 'stop' | 'cancel')
  : undefined
const serviceBusyAnswer = ['force', 'keep'].includes(process.env.LITCH_QUIT_SERVICE_BUSY ?? '')
  ? (process.env.LITCH_QUIT_SERVICE_BUSY as 'force' | 'keep')
  : undefined

function settleService(): Promise<ServiceQuitOutcome> {
  const dataDir = app.getPath('userData')
  return askServiceBeforeQuit({
    lang: menuLang ?? 'en',
    stoppable: () => askCoreService(1500),
    choice: () => readServiceQuitChoice(dataDir),
    remember(choice) {
      writeServiceQuitChoice(dataDir, choice)
      refreshMenu()
    },
    window: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    // 自检不弹窗；没给回答的自检按“保留”算，免得卡在一个看不见的对话框上，也不去关真的服务
    ...(serviceAnswer ? { answer: serviceAnswer } : smoke ? { answer: 'keep' as const } : {}),
  })
}

/** 用户选了退出时一起关后台服务：应用真的退出时（will-quit）再关 */
let stopServiceAfterQuit = false

/** 应用菜单现在用的语言。界面起来之前先按系统的来，界面报上来之后跟界面的 */
let menuLang: MenuLang | null = null
function refreshMenu(): void {
  if (!menuLang) return
  const dataDir = app.getPath('userData')
  installMenu(menuLang, {
    toggleSidebar() {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      window?.webContents.send(MENU, 'sidebar.toggle')
    },
    toggleTerminal() {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      window?.webContents.send(MENU, 'terminal.toggle')
    },
    toggleSide() {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      window?.webContents.send(MENU, 'side.toggle')
    },
    openSettings(section) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      window?.webContents.send(MENU, section === 'about' ? 'settings.about' : 'settings.open')
    },
    zoom(step) {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      window?.webContents.send(MENU, `zoom.${step}`)
    },
    checkUpdates:
      updater && updatePlatform()
        ? () => {
            const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            window?.webContents.send(MENU, 'settings.about')
            void updater?.check()
          }
        : null,
    askOnQuit: () => readQuitChoice(dataDir) === 'ask',
    setAskOnQuit(ask) {
      try {
        // 关掉“每次都问”等于记住“留着”：这是不结束任何东西的那一种
        writeQuitChoice(dataDir, ask ? 'ask' : 'leave')
      } catch (error) {
        dialog.showErrorBox(app.name, String(error))
      }
      refreshMenu()
    },
    askServiceOnQuit: () => readServiceQuitChoice(dataDir) === 'ask',
    setAskServiceOnQuit(ask) {
      try {
        // 关掉“每次都问”等于记住“保留”：这是不打断任何东西的那一种
        writeServiceQuitChoice(dataDir, ask ? 'ask' : 'keep')
      } catch (error) {
        dialog.showErrorBox(app.name, String(error))
      }
      refreshMenu()
    },
  })
}
function showMenu(lang: MenuLang): void {
  if (lang === menuLang) return
  menuLang = lang
  refreshMenu()
}

// 界面的语言是用户在界面里选的，存在界面那边：它启动时和每次改的时候报一声，菜单跟着换。
// 也转告核心：本机的适配器说的话会原样显示在界面上，得是同一种语言
ipcMain.on(SET_LANGUAGE, (event, lang: unknown) => {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) return
  if (lang !== 'zh-CN' && lang !== 'en') return
  showMenu(lang)
  core?.postMessage({ type: LANGUAGE, lang })
  computerUse?.setLanguage(lang)
})

/** 这一次退出，终端的事已经问过、办过了 */
let quitSettled = false
/** 正在问：这期间再按一次退出不重复问 */
let quitAsking = false

app.on('before-quit', (event) => {
  if (!quitSettled && !quitting && core) {
    // 先别退：问清楚终端怎么办（留在设备上、结束、还是不退了），办完再退
    event.preventDefault()
    if (quitAsking) return
    quitAsking = true
    void settleQuit()
      .catch((error: unknown): QuitOutcome => {
        console.error(`退出前清点终端失败：${String(error)}`)
        return { proceed: true, alive: null, asked: false, did: 'none' }
      })
      .then(async (outcome) => {
        if (!outcome.proceed) return false
        // 终端问完再问后台服务；点了取消就都不退了
        const service = await settleService().catch((error: unknown): ServiceQuitOutcome => {
          console.error(`退出前问后台服务失败：${String(error)}`)
          return { proceed: true, stop: false, asked: false }
        })
        stopServiceAfterQuit = service.stop
        return service.proceed
      })
      .then((proceed) => {
        quitAsking = false
        if (!proceed) return
        quitSettled = true
        app.quit()
      })
    return
  }
  quitting = true
  core?.kill()
  void computerUse?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// 自检时不抢单实例锁，免得和正在用的那个实例互相影响
if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  // 这里不能在模块顶层等待“就绪”：Electron 要等入口模块执行完才发出就绪事件，顶层一等就成了互相等
  void app.whenReady().then(() => {
    if (smoke) app.dock?.hide()
    // 没打包的时候程序坞上是 Electron 自己的图标，换成我们的，免得和别的 Electron 应用分不清
    else if (!app.isPackaged) app.dock?.setIcon(join(assetsDir, 'icon-dock.png'))
    showMenu(forcedLang ?? (app.getLocale().startsWith('zh') ? 'zh-CN' : 'en'))
    protocol.handle('app', serveUi)
    // 上次的外观：窗口一建出来就按它来。地址里临时指定了皮肤、明暗的这一次按指定的
    look =
      parseLook({ ...readLook(app.getPath('userData')), ...forcedLook }) ??
      readLook(app.getPath('userData'))
    // 内置浏览器：宿主、litch_browser 的执行器、界面和设置页用的消息（browser/install.mts）
    browser = installBrowser({ isUiUrl, userData: app.getPath('userData') })
    clientTools.add(browser.executor)
    startCore()
    // 产品手册装进本机的 harness：在后台做，不挡窗口
    manualSkill.start()
    updater = createAppUpdater()
    updater?.start()
    // 菜单里的“检查更新…”要等更新器建出来才放
    refreshMenu()
    const window = createWindow()
    const finish = (ok: boolean) => {
      // 直接退出不会经过“退出前”的事件，这里自己把核心停掉，免得它被当成意外退出再拉起来
      quitting = true
      core?.kill()
      app.exit(ok ? 0 : 1)
    }
    if (shotsDir) {
      const load = (params: Record<string, string>) =>
        window.loadURL(uiUrl({ ...forcedLook, ...params }))
      void runShots(window, shotsDir, load).then(finish)
    } else if (smokeMode) {
      void runSmoke(window, smokeMode, {
        quit: (answer) => settleQuit(answer),
        // 把核心进程杀掉：上面的退出处理会把它重新拉起来，并让窗口重新加载
        restartCore: () => core?.kill(),
        // 当作用户点了应用菜单里的那一项：走的是菜单项自己的处理函数
        menu(id) {
          const item = Menu.getApplicationMenu()?.getMenuItemById(id)
          if (!item) return false
          item.click()
          return true
        },
        load: (params) => window.loadURL(uiUrl(params)),
        born: () => born,
        minSize: MIN_SIZE,
        version: app.getVersion(),
      }).then(finish)
    }
  })
}
