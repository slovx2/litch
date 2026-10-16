// 终端验收在主进程这一头的编排：页面里的脚本分几段送进去，中间夹着要主进程做的事
// （改窗口大小、走一遍退出前的清点、把核心重启）。
import type { BrowserWindow } from 'electron'
import { mockBasics } from './probe-terminal.mjs'
import { deviceDrop, deviceRestored, deviceTabs, realBasics } from './probe-terminal-device.mjs'
import { deviceClose, entryDrop, realFlood, tabIds } from './probe-terminal-ends.mjs'
import { mockFlow, mockHome } from './probe-terminal-flow.mjs'
import {
  judgeMock,
  type MockSeen,
  mockNumbers,
  type QuitSeen,
  type WindowSize,
} from './probe-terminal-judge.mjs'
import {
  type DeviceSeen,
  type EntrySeen,
  judgeDevice,
  judgeEntry,
  realNumbers,
} from './probe-terminal-judge-real.mjs'
import { installTerminalKit, type TerminalKit } from './probe-terminal-kit.mjs'
import { lookSeen, mockClose, openMore, tabStates } from './probe-terminal-look.mjs'
import { heightSeen, sizeSeen } from './probe-terminal-size.mjs'
import type { SmokeHooks } from './smoke.mjs'

export type TerminalMode = 'terminal' | 'terminal-device' | 'terminal-entry'

/**
 * 时间上的线（按键回显、帧间隔、中断多久生效）只在够快的机器上划：流水线的虚拟机没有显卡、核也少，
 * 那里只报数，另外留几条宽得多的线拦“卡死了”。LITCH_CHECK_LENIENT=1 打开；流水线上（CI=true）默认就是，
 * 想在流水线上照样按严的来就给 LITCH_CHECK_LENIENT=0。别的检查（功能对不对）两种都一样严。
 */
export const lenient =
  process.env.LITCH_CHECK_LENIENT === '1' ||
  (process.env.CI === 'true' && process.env.LITCH_CHECK_LENIENT !== '0')

/** 一遍验收最多跑这么久。到点不死等：把走到哪一步、页面当时的样子报出来 */
const DEADLINE_MS: Record<TerminalMode, number> = {
  terminal: 240_000,
  'terminal-device': 420_000,
  'terminal-entry': 420_000,
}

/** 走到哪一步了。只记在内存里，跑不完的时候才报出去 */
const steps: string[] = []
const started = Date.now()
const step = (name: string) => {
  steps.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${name}`)
}

export async function inPage<T, A extends unknown[]>(
  window: BrowserWindow,
  probe: (...args: A) => Promise<T> | T,
  ...args: A
): Promise<T> {
  step(probe.name)
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return (await window.webContents.executeJavaScript(`(${probe.toString()})(${list})`, true)) as T
}

/** 把窗口改成几种大小，每种都问一遍终端里的程序看到的行列数，再从画面上数一遍 */
export async function sizesSeen(window: BrowserWindow, command: string): Promise<WindowSize[]> {
  const [width = 0, height = 0] = window.getSize()
  const seen: WindowSize[] = []
  for (const [dw, dh] of [
    [0, 0],
    [-220, -120],
    [90, 70],
  ] as const) {
    window.setSize(width + dw, height + dh)
    // 页面里看到的大小：页面要等收到它，再量
    const [inner = 0, innerHeight = 0] = window.getContentSize()
    seen.push({
      width: width + dw,
      height: height + dh,
      seen: await inPage(window, sizeSeen, command, inner, innerHeight),
    })
  }
  window.setSize(width, height)
  return seen
}

async function runMock(window: BrowserWindow, hooks: SmokeHooks): Promise<MockSeen> {
  await inPage(window, installTerminalKit)
  const basics = await inPage(window, mockBasics)
  const flow = await inPage(window, mockFlow)
  const close = await inPage(window, mockClose)
  const sizes = await sizesSeen(window, 'size')
  const height = await inPage(window, heightSeen)
  const look = await inPage(window, lookSeen)
  // 退出前的清点：要有东西可数，再开一个凑成两个
  await inPage(window, openMore, 1)
  const before = await inPage(window, tabStates, 2)
  step('退出：取消')
  const cancel = await hooks.quit('cancel')
  const afterCancel = await inPage(window, tabStates)
  step('退出：留着')
  const leave = await hooks.quit('leave')
  const afterLeave = await inPage(window, tabStates)
  step('退出：结束')
  const end = await hooks.quit('end')
  const afterEnd = await inPage(window, tabStates, 0)
  const quit: QuitSeen = { before, cancel, afterCancel, leave, afterLeave, end, afterEnd }
  // 新建对话页上的终端：排在最后，这时一个终端都没有，换组不会多开出来
  const home = await inPage(window, mockHome)
  return { basics, flow, close, sizes, height, look, quit, home }
}

async function runDevice(window: BrowserWindow, hooks: SmokeHooks): Promise<DeviceSeen> {
  await inPage(window, installTerminalKit)
  const basics = await inPage(window, realBasics)
  const sizes = await sizesSeen(window, 'stty size')
  const flood = await inPage(window, realFlood)
  const drop = await inPage(window, deviceDrop)
  const made = await inPage(window, deviceTabs)

  // 把核心杀掉：外壳会把它重新拉起来、让窗口重新加载。这一头什么都不记得了，终端要从设备上认回来
  const reloaded = new Promise<void>((done) => {
    window.webContents.once('did-finish-load', () => done())
  })
  step('重启核心')
  hooks.restartCore()
  await reloaded
  await inPage(window, installTerminalKit)
  const restored = await inPage(window, deviceRestored, basics.session)
  const close = await inPage(window, deviceClose)

  // 退出前的清点。先试“结束”：开成标签的都结束，留在设备上没在看的那个不动
  await inPage(window, openMore, 1)
  const beforeEnd = await inPage(window, tabIds, 2)
  step('退出：结束')
  const end = await hooks.quit('end')
  const afterEnd = await inPage(window, tabIds, 0)
  // 再试“留着”
  await inPage(window, openMore, 1)
  const beforeLeave = await inPage(window, tabIds, 1)
  step('退出：留着')
  const leave = await hooks.quit('leave')
  const afterLeave = await inPage(window, tabIds)
  return {
    basics,
    sizes,
    flood,
    drop,
    made,
    restored,
    close,
    beforeEnd,
    end,
    afterEnd,
    beforeLeave,
    leave,
    afterLeave,
    outside: { gone: [close.ended, ...beforeEnd], kept: [close.left, ...beforeLeave] },
  }
}

async function runEntry(window: BrowserWindow, hooks: SmokeHooks): Promise<EntrySeen> {
  await inPage(window, installTerminalKit)
  const basics = await inPage(window, realBasics)
  const sizes = await sizesSeen(window, 'stty size')
  const flood = await inPage(window, realFlood)
  const drop = await inPage(window, entryDrop)
  step('退出：取消')
  const cancel = await hooks.quit('cancel')
  step('退出：留着')
  const leave = await hooks.quit('leave')
  return { basics, sizes, flood, drop, cancel, leave }
}

async function run(
  window: BrowserWindow,
  mode: TerminalMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  if (mode === 'terminal') {
    const seen = await runMock(window, hooks)
    return [{ ...seen, lenient, numbers: mockNumbers(seen) }, judgeMock(seen, lenient)]
  }
  if (mode === 'terminal-device') {
    const seen = await runDevice(window, hooks)
    return [
      { ...seen, lenient, numbers: realNumbers(seen.basics, seen.flood) },
      judgeDevice(seen, lenient),
    ]
  }
  const seen = await runEntry(window, hooks)
  return [
    { ...seen, lenient, numbers: realNumbers(seen.basics, seen.flood) },
    judgeEntry(seen, lenient),
  ]
}

/** 到点还没跑完：走到哪一步、页面当时什么样（页面答得上来的话） */
async function overdue(window: BrowserWindow, mode: TerminalMode): Promise<string> {
  const page = await Promise.race([
    window.webContents
      .executeJavaScript(
        `(${(() => (window as unknown as { __termKit?: TerminalKit }).__termKit?.where() ?? '页面里还没装上验收的工具').toString()})()`,
        true,
      )
      .catch((error: unknown) => `页面问不到：${String(error)}`),
    new Promise<string>((done) => setTimeout(() => done('页面三秒没有应答'), 3000)),
  ])
  return `验收跑了 ${DEADLINE_MS[mode] / 1000} 秒还没完。走过的步骤：${steps.join(' → ')}。页面：${String(page)}`
}

export async function runTerminalChecks(
  window: BrowserWindow,
  mode: TerminalMode,
  hooks: SmokeHooks,
): Promise<readonly [object, string[]]> {
  let stop: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly [object, string[]]>((done) => {
    stop = setTimeout(() => {
      void overdue(window, mode).then((what) => done([{ lenient, steps }, [what]]))
    }, DEADLINE_MS[mode])
  })
  try {
    return await Promise.race([run(window, mode, hooks), late])
  } finally {
    clearTimeout(stop)
  }
}
