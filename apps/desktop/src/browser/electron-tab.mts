// 一个标签：一块 WebContentsView，加上它的调试器（CDP，经白名单）、控制台记录、对话框、提示。
// 视图只由主进程持有：不带预加载脚本、开沙箱和上下文隔离、不开 Node，用共用的持久分区。
// 它碰不到界面，也拿不到通往核心的端口（那个端口只给界面自己的主框架，见 main.mts 的 REQUEST_CORE_PORT）。
import { type Event, WebContentsView } from 'electron'
import { CdpRefused, isAllowedCdp } from './cdp-allow.mjs'
import type {
  BrowserPage,
  ConsoleEntry,
  DialogInfo,
  LoadOutcome,
  TabInfo,
  TabKind,
  TabOwner,
} from './model.mjs'
import { BLANK, isOpenable } from './url.mjs'

/** 共用的持久分区：登录一次，各个会话的代理都能用（决 195） */
export const PARTITION = 'persist:litch-browser'

const CONSOLE_KEEP = 200
/** 没显示的时候页面按这么大排版（代理看到的视口） */
export const HIDDEN_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }
/** 一条 CDP 命令最多等多久。跑脚本的命令自己带 30 秒的时限，这里留出余量 */
const CDP_TIMEOUT_MS = 35_000
const NOTICES_KEEP = 20

export interface TabHooks {
  /** 标签的样子变了（地址、标题、加载、代理在用……） */
  changed(): void
  /** 代理在用时网页自己发起的跳转放不放行 */
  gate(page: BrowserPage, url: string): boolean
  /** 网页要开新窗口：在内置浏览器里开新标签 */
  popup(from: HostTab, url: string): void
}

export interface HostTab extends BrowserPage {
  readonly view: WebContentsView
  owner: TabOwner
  kind: TabKind
  keep: boolean
  /** 回合结束：答掉开着的对话框、断开调试器、撤掉代理在用 */
  release(): void
  destroy(): void
  /** 加一条提示（被拦下的下载之类，宿主用） */
  notice(text: string): void
}

/** 子框架不许去的协议：本机文件、界面自己的、浏览器内部页 */
const SUBFRAME_BLOCKED = /^(file|app|chrome|chrome-extension|devtools|view-source):/i

export function createTab(
  id: string,
  owner: TabOwner,
  kind: TabKind,
  keep: boolean,
  hooks: TabHooks,
): HostTab {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      plugins: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      // 代理开的标签不弹系统的对话框：对话框经 CDP 交给模型答（没挂调试器时自动关掉）。用户的照常弹
      disableDialogs: kind === 'agent',
      safeDialogs: true,
    },
  })
  view.setBackgroundColor('#ffffff')
  // 没显示在面板里的视图也要有大小：0×0 的页面截不了图、点不到东西（见 electron-host.mts 开头）
  view.setBounds(HIDDEN_BOUNDS)
  const contents = view.webContents
  const cdp = contents.debugger
  let consoleEntries: ConsoleEntry[] = []
  let notices: string[] = []
  let dialog: DialogInfo | null = null
  let dialogWaiters: Array<(info: DialogInfo) => void> = []
  let agentActive = false
  let highlightTimer: ReturnType<typeof setTimeout> | null = null
  let attaching: Promise<void> | null = null

  const addNotice = (text: string) => {
    notices.push(text)
    if (notices.length > NOTICES_KEEP) notices = notices.slice(-NOTICES_KEEP)
  }

  const onMessage = (_event: Event, method: string, params: Record<string, unknown>) => {
    if (method === 'Page.javascriptDialogOpening') {
      dialog = {
        type: String(params.type ?? 'alert'),
        message: String(params.message ?? ''),
        defaultPrompt: String(params.defaultPrompt ?? ''),
      }
      const waiters = dialogWaiters
      dialogWaiters = []
      for (const resolve of waiters) resolve(dialog)
      hooks.changed()
    } else if (method === 'Page.javascriptDialogClosed') {
      dialog = null
      hooks.changed()
    }
  }
  cdp.on('message', onMessage)
  cdp.on('detach', () => {
    attaching = null
    dialog = null
  })

  /** 挂上调试器，打开要用的几个域。经白名单发，和工具发的是同一个出口 */
  const attach = (): Promise<void> => {
    if (cdp.isAttached() && attaching) return attaching
    attaching = (async () => {
      if (!cdp.isAttached()) cdp.attach('1.3')
      await cdp.sendCommand('Page.enable')
      await cdp.sendCommand('DOM.enable')
      await cdp.sendCommand('Overlay.enable')
      // 页面不在前台（面板关着、窗口在后面）时也能拿到焦点，代理照样能打字
      await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    })()
    attaching.catch(() => {
      attaching = null
    })
    return attaching
  }

  const send = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (!isAllowedCdp(method)) throw new CdpRefused(method)
    await attach()
    if (method === 'Page.captureScreenshot' && highlightTimer) {
      // 截图里不要代理点哪里的那个框
      clearTimeout(highlightTimer)
      highlightTimer = null
      await cdp.sendCommand('Overlay.hideHighlight').catch(() => {})
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${method} did not answer in time`)),
        CDP_TIMEOUT_MS,
      )
    })
    try {
      return (await Promise.race([cdp.sendCommand(method, params), late])) as T
    } finally {
      clearTimeout(timer)
    }
  }

  const settled = (timeoutMs: number, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (!contents.isLoading()) return resolve(true)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        contents.off('did-stop-loading', onStop)
        signal?.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      const onStop = () => done(true)
      const onAbort = () => done(false)
      const timer = setTimeout(() => done(false), timeoutMs)
      contents.on('did-stop-loading', onStop)
      signal?.addEventListener('abort', onAbort, { once: true })
    })

  /**
   * 加载并等它停下。loadURL 自己的应答不全信：前一次加载留下的完成事件偶尔会让它提前兑现（自检里见过），
   * 所以之后再等页面真的停下，主框架加载失败另外听 did-fail-load
   */
  const load = async (work: () => Promise<unknown>, timeoutMs: number): Promise<LoadOutcome> => {
    const until = Date.now() + timeoutMs
    let error: string | undefined
    let failed: string | undefined
    const onFail = (
      _event: unknown,
      code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      // -3 是被取消（被新的导航顶掉、被拦下），不算这一次失败
      if (isMainFrame && code !== -3) failed = `${description} (${code})`
    }
    contents.on('did-fail-load', onFail)
    try {
      const started = work().catch((reason: unknown) => {
        error = reason instanceof Error ? reason.message : String(reason)
      })
      const finished = await Promise.race([
        started.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ])
      if (finished) await settled(Math.max(until - Date.now(), 0))
      if (failed) return { ok: false, error: failed }
      if (!finished || contents.isLoading()) {
        return { ok: false, error: `still loading after ${timeoutMs} ms` }
      }
      // 地址被拦下（比如重定向去了没审批的来源）时 loadURL 报 ERR_ABORTED，提示里写着原因
      return error ? { ok: false, error } : { ok: true }
    } finally {
      contents.off('did-fail-load', onFail)
    }
  }

  // ---------- 网页自己的事 ----------

  contents.setWindowOpenHandler(({ url }) => {
    if (isOpenable(url) && url !== BLANK) hooks.popup(tab, url)
    return { action: 'deny' }
  })
  contents.on('will-frame-navigate', (event) => {
    const url = event.url
    if (!event.isMainFrame) {
      if (SUBFRAME_BLOCKED.test(url)) event.preventDefault()
      return
    }
    if (!isOpenable(url)) {
      event.preventDefault()
      addNotice(`Navigation to ${url} was blocked: only http and https pages can be opened.`)
      return
    }
    if (agentActive && !hooks.gate(tab, url)) {
      event.preventDefault()
      addNotice(
        `The page tried to open ${url}, which is not approved yet, so it was blocked. Call \`navigate\` with that address to ask the user.`,
      )
    }
  })
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame) return
    if (!isOpenable(event.url) || (agentActive && !hooks.gate(tab, event.url))) {
      event.preventDefault()
      addNotice(`A redirect to ${event.url} was blocked because that site is not approved yet.`)
    }
  })
  contents.on('console-message', (event) => {
    const level =
      event.level === 'warning' || event.level === 'error' || event.level === 'debug'
        ? event.level
        : 'info'
    consoleEntries.push({
      level,
      text: event.message.slice(0, 4000),
      source: event.sourceId ? `${event.sourceId}:${event.lineNumber}` : '',
      at: Date.now(),
    })
    if (consoleEntries.length > CONSOLE_KEEP) consoleEntries = consoleEntries.slice(-CONSOLE_KEEP)
  })
  contents.on('render-process-gone', (_event, details) => {
    addNotice(`The page crashed (${details.reason}). Reload it with \`navigate\` action "reload".`)
    hooks.changed()
  })
  for (const name of [
    'did-start-loading',
    'did-stop-loading',
    'page-title-updated',
    'did-navigate',
    'did-navigate-in-page',
  ] as const) {
    contents.on(name as 'did-start-loading', () => hooks.changed())
  }

  const tab: HostTab = {
    id,
    view,
    owner,
    kind,
    keep,
    info(): TabInfo {
      const history = contents.navigationHistory
      return {
        id,
        owner: tab.owner,
        kind: tab.kind,
        url: contents.getURL() || BLANK,
        title: contents.getTitle(),
        loading: contents.isLoading(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
        agentActive,
        keep: tab.keep,
      }
    },
    load: (url, timeoutMs) => load(() => contents.loadURL(url), timeoutMs),
    history(action, timeoutMs) {
      const history = contents.navigationHistory
      if (action === 'back' && !history.canGoBack())
        return Promise.resolve({ ok: false, error: 'no previous page' })
      if (action === 'forward' && !history.canGoForward())
        return Promise.resolve({ ok: false, error: 'no next page' })
      return load(async () => {
        if (action === 'back') history.goBack()
        else if (action === 'forward') history.goForward()
        else contents.reload()
        await new Promise((resolve) => setTimeout(resolve, 50))
        await settled(timeoutMs)
      }, timeoutMs)
    },
    waitForLoad: (timeoutMs, signal) => settled(timeoutMs, signal),
    cdp: send,
    consoleEntries: () => [...consoleEntries],
    clearConsole() {
      consoleEntries = []
    },
    dialog: () => dialog,
    dialogOpened: () =>
      dialog ? Promise.resolve(dialog) : new Promise((resolve) => dialogWaiters.push(resolve)),
    takeNotices() {
      const taken = notices
      notices = []
      return taken
    },
    setAgentActive(active) {
      if (agentActive === active) return
      agentActive = active
      // 代理在用时不节流：面板关着的时候页面也照常跑定时器和动画（V0 ③ 实测）
      contents.setBackgroundThrottling(!active)
      hooks.changed()
    },
    async pointAt(x, y, width = 12, height = 12) {
      try {
        await send('Overlay.highlightRect', {
          x: Math.round(x - width / 2),
          y: Math.round(y - height / 2),
          width: Math.max(Math.round(width), 4),
          height: Math.max(Math.round(height), 4),
          color: { r: 255, g: 140, b: 0, a: 0.25 },
          outlineColor: { r: 255, g: 110, b: 0, a: 0.9 },
        })
        if (highlightTimer) clearTimeout(highlightTimer)
        highlightTimer = setTimeout(() => {
          highlightTimer = null
          if (cdp.isAttached()) void cdp.sendCommand('Overlay.hideHighlight').catch(() => {})
        }, 700)
      } catch {
        // 画不出来不影响动手
      }
    },
    release() {
      if (cdp.isAttached()) {
        // 开着的对话框先关掉，不然页面一直停着
        if (dialog)
          void cdp.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
        try {
          cdp.detach()
        } catch {
          // 已经断开了
        }
      }
      attaching = null
      dialog = null
      dialogWaiters = []
      tab.setAgentActive(false)
    },
    destroy() {
      tab.release()
      if (!contents.isDestroyed()) contents.close()
    },
    notice: addNotice,
  }
  return tab
}
