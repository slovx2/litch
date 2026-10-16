// 文件面板验收在主进程这一头的编排：页面里的脚本分几段送进去，中间夹着要主进程做的事
// （改窗口大小、点应用菜单、把核心重启）。三种对面：模拟核心、隔离的设备夹具、单个 harness 的入口，
// 由 scripts/check-files.mjs 各起一次外壳。
import type { BrowserWindow } from 'electron'
import { SIDE_ITEM } from './menu.mjs'
import { mockTree } from './probe-files.mjs'
import { frameSeen, keysSeen, reloadSeen, sideBecame } from './probe-files-frame.mjs'
import { judgeReal, type RealDirs, type RealSeen, realNumbers } from './probe-files-judge-real.mjs'
import { judgeMock, type MockSeen, mockNumbers, type ShellSeen } from './probe-files-judge-rest.mjs'
import { type FilesKit, installFilesKit } from './probe-files-kit.mjs'
import { mockLinks, mockMenu } from './probe-files-links.mjs'
import { filesLook, mockPlaces } from './probe-files-places.mjs'
import { realTree } from './probe-files-real.mjs'
import { realView } from './probe-files-real-view.mjs'
import { newPageSeen, roomSeen, sidePanel, termPanel } from './probe-files-room.mjs'
import { mockSearch, mockView } from './probe-files-view.mjs'
import { installTerminalKit } from './probe-terminal-kit.mjs'
import { sizeSeen } from './probe-terminal-size.mjs'
import type { SmokeHooks } from './smoke.mjs'

export type FilesMode = 'files' | 'files-device' | 'files-entry'

/**
 * 时间上的线（展开大目录、帧间隔、开大文件、定位到行）只在够快的机器上划，和终端验收是同一个开关：
 * LITCH_CHECK_LENIENT=1 打开宽的那一套；流水线上（CI=true）默认就是宽的，想照样按严的来就给 LITCH_CHECK_LENIENT=0。
 * 功能对不对的检查两套一样严。
 */
export const lenient =
  process.env.LITCH_CHECK_LENIENT === '1' ||
  (process.env.CI === 'true' && process.env.LITCH_CHECK_LENIENT !== '0')

/** 一遍验收最多跑这么久。到点不死等：把走到哪一步、页面当时的样子报出来 */
const DEADLINE_MS: Record<FilesMode, number> = {
  files: 300_000,
  'files-device': 420_000,
  'files-entry': 420_000,
}

/** 模拟核心里用的那几个会话（示例数据里的标题）。用哪个都明着去点，不靠启动后选中了谁 */
const MOCK = {
  // 本机、litch 项目，闲着的，它的 harness 是能用的（要往里发消息）
  home: '设备进程的转发开销基准',
  // 同一个项目里带文件改动的那个
  tools: '把运行时与 SSH 入口的启动拆开',
  // 本机、docs-site 项目
  other: '远程设备安装指引',
  // 不属于任何项目，工作目录是 /Users/dev/notes/launchd
  loose: '查一下 launchd 的 KeepAlive 语义',
  // 同一个项目里正等着审批的那个：一打开就有请求卡片
  waiting: '聚合面：会话列表合并与复合游标',
  // nas：不提供文件访问；build-01：不提供找文件；gpu-box：没连上
  noFiles: '整理快照保留策略',
  noSearch: '跑一遍官方桌面端请求回放',
  offline: '评测脚本并行化',
}

/** 走到哪一步了。只记在内存里，跑不完的时候才报出去 */
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

/** 面板这个框：宽窄窗口、和主区域那几行并存、新建对话页、终端的行列数、应用菜单、快捷键、重开之后 */
async function shellSeen(window: BrowserWindow, hooks: SmokeHooks): Promise<ShellSeen> {
  const [width = 0, height = 0] = window.getSize()
  const [minWidth = 0, minHeight = 0] = window.getMinimumSize()
  /** 改窗口大小，返回页面里应该看到的大小：页面要等收到它，再量 */
  const sized = (toWidth: number, toHeight: number) => {
    window.setSize(toWidth, toHeight)
    const [inner = 0, innerHeight = 0] = window.getContentSize()
    return { inner, innerHeight }
  }
  const wide = await inPage(window, frameSeen)
  // 缩到允许的最窄最矮：面板还开着，输入框和请求卡片都得在
  const least = sized(minWidth, minHeight)
  const narrow = await inPage(window, frameSeen, least.inner)
  const room = await inPage(window, roomSeen, MOCK.waiting, least.inner, least.innerHeight)
  const middle = await inPage(window, frameSeen, sized(1100, height).inner)
  const full = sized(width, height)
  const restored = await inPage(window, frameSeen, full.inner)
  const newPage = await inPage(window, newPageSeen, {
    session: MOCK.home,
    workspace: 'docs-site',
    none: '无项目',
    device: 'build-01',
    deviceWorkspace: 'infra',
  })

  // 面板一开一合，对话区的宽度跟着变，终端的行列数要跟上：终端里的程序看到的和屏幕上画的对得上
  await inPage(window, installTerminalKit)
  await inPage(window, termPanel, true)
  const sizeNow = () => inPage(window, sizeSeen, 'size', full.inner, full.innerHeight)
  const withSide = await sizeNow()
  await inPage(window, sidePanel, false)
  const withoutSide = await sizeNow()
  await inPage(window, sidePanel, true)
  const again = await sizeNow()
  await inPage(window, termPanel, false)

  step('应用菜单：收起')
  const menuFound = hooks.menu(SIDE_ITEM)
  const menuClosed = await inPage(window, sideBecame, false)
  step('应用菜单：打开')
  hooks.menu(SIDE_ITEM)
  const menuOpened = await inPage(window, sideBecame, true)
  const keys = await inPage(window, keysSeen)
  const before = await inPage(window, frameSeen)

  // 把核心杀掉：外壳会把它重新拉起来、让窗口重新加载，和应用重开差不多
  const reloaded = new Promise<void>((done) => {
    window.webContents.once('did-finish-load', () => done())
  })
  step('重启核心')
  hooks.restartCore()
  await reloaded
  await inPage(window, installFilesKit)
  const reload = await inPage(window, reloadSeen, MOCK.home)
  return {
    wide,
    narrow,
    room,
    middle,
    restored,
    minWidth,
    newPage,
    term: { withSide, withoutSide, again },
    menuFound,
    menuClosed,
    menuOpened,
    keys,
    widthBefore: before.side,
    reload,
  }
}

async function runMock(window: BrowserWindow, hooks: SmokeHooks): Promise<MockSeen> {
  await inPage(window, installFilesKit)
  const tree = await inPage(window, mockTree, MOCK.home)
  const view = await inPage(window, mockView)
  const search = await inPage(window, mockSearch)
  const menu = await inPage(window, mockMenu)
  const links = await inPage(window, mockLinks, MOCK.home, MOCK.tools)
  const places = await inPage(window, mockPlaces, {
    home: MOCK.home,
    other: MOCK.other,
    loose: MOCK.loose,
    noFiles: MOCK.noFiles,
    noSearch: MOCK.noSearch,
    offline: MOCK.offline,
  })
  const look = await inPage(window, filesLook)
  const shell = await shellSeen(window, hooks)
  return { tree, view, search, menu, links, places, look, shell }
}

async function runReal(window: BrowserWindow, mode: FilesMode): Promise<RealSeen> {
  // 夹具里那几个目录在哪，由起验收的脚本告诉我们
  const dirs = JSON.parse(process.env.LITCH_FILES_DIRS ?? '{}') as RealDirs
  // 两种夹具里工作目录是项目根的会话
  const session = mode === 'files-device' ? '给列表加上分页' : '逐个检查一百多个文件'
  await inPage(window, installFilesKit)
  const tree = await inPage(window, realTree, session, dirs.outside)
  const view = await inPage(window, realView, {
    session,
    // 没起名字的那个会话，工作目录在另一个目录里
    other: '帮我想三个周报的小标题',
    // 入口夹具里有一个工作目录在子目录里、回答里提到了文件名的会话
    cwdSession: mode === 'files-entry' ? '给首页加一个状态条' : null,
  })
  return { tree, view }
}

async function run(
  window: BrowserWindow,
  mode: FilesMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  if (mode === 'files') {
    const seen = await runMock(window, hooks)
    return [{ ...seen, lenient, numbers: mockNumbers(seen) }, judgeMock(seen, lenient)]
  }
  const dirs = JSON.parse(process.env.LITCH_FILES_DIRS ?? '{}') as RealDirs
  const seen = await runReal(window, mode)
  return [
    { ...seen, lenient, numbers: realNumbers(seen) },
    judgeReal(seen, dirs, mode === 'files-entry', lenient),
  ]
}

/** 到点还没跑完：走到哪一步、页面当时什么样（页面答得上来的话） */
async function overdue(window: BrowserWindow, mode: FilesMode): Promise<string> {
  const page = await Promise.race([
    window.webContents
      .executeJavaScript(
        `(${(() => (window as unknown as { __filesKit?: FilesKit }).__filesKit?.where() ?? '页面里还没装上验收的工具').toString()})()`,
        true,
      )
      .catch((error: unknown) => `页面问不到：${String(error)}`),
    new Promise<string>((done) => setTimeout(() => done('页面三秒没有应答'), 3000)),
  ])
  return `验收跑了 ${DEADLINE_MS[mode] / 1000} 秒还没完。走过的步骤：${steps.join(' → ')}。页面：${String(page)}`
}

export async function runFilesChecks(
  window: BrowserWindow,
  mode: FilesMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  let stop: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly [object, string[]]>((done) => {
    stop = setTimeout(() => {
      void overdue(window, mode).then((what) => done([{ lenient, steps }, [what]]))
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
