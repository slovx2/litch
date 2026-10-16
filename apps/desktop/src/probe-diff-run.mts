// 差异面板验收在主进程这一头的编排：页面里的脚本分几段送进去，中间夹着要主进程做的事（改窗口大小）。
// 三种对面：模拟核心、隔离的设备夹具、单个 harness 的入口，由 scripts/check-diff.mjs 各起一次外壳。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { mockBasics, mockWrites } from './probe-diff.mjs'
import {
  diffLook,
  mockMany,
  mockNotes,
  mockPlaces,
  mockTurn,
  narrowSeen,
  roomySeen,
} from './probe-diff-flow.mjs'
import {
  judgeMock,
  judgeReal,
  type MockSeen,
  mockNumbers,
  type RealSeenAll,
  realNumbers,
} from './probe-diff-judge.mjs'
import { type DiffKit, installDiffKit } from './probe-diff-kit.mjs'
import { realDiff, realMany } from './probe-diff-real.mjs'
import { installFilesKit } from './probe-files-kit.mjs'

export type DiffMode = 'diff' | 'diff-device' | 'diff-entry'

/**
 * 时间上的线只在够快的机器上划，和文件面板、终端的验收是同一个开关：
 * LITCH_CHECK_LENIENT=1 打开宽的那一套；流水线上（CI=true）默认就是宽的，想照样按严的来就给 LITCH_CHECK_LENIENT=0。
 * 功能对不对的检查两套一样严。
 */
export const lenient =
  process.env.LITCH_CHECK_LENIENT === '1' ||
  (process.env.CI === 'true' && process.env.LITCH_CHECK_LENIENT !== '0')

/** 一遍验收最多跑这么久。到点不死等：把走到哪一步、页面当时的样子报出来 */
const DEADLINE_MS: Record<DiffMode, number> = {
  diff: 300_000,
  'diff-device': 420_000,
  'diff-entry': 420_000,
}

/** 模拟核心里用的那几个会话（示例数据里的标题）。用哪个都明着去点，不靠启动后选中了谁 */
const MOCK = {
  // 本机、litch 项目（各种改动都有的那个仓库），闲着的，它的 harness 是能用的（要往里发消息）
  home: '设备进程的转发开销基准',
  // 同一个项目里的另一个会话：看批注是跟着会话存的
  tools: '把运行时与 SSH 入口的启动拆开',
  // 本机、docs-site 项目：四百多个文件的改动
  many: '远程设备安装指引',
  // build-01 上的 litch：改了上万行的文件、装不下的日志、单行很长的文件。
  // 这两个只是点开来看，挑的是工作目录正好在仓库根上的会话：同一个项目里另有会话的工作目录
  // 是子目录或者在项目外面（侧栏拿它们演示工作目录的记号），那几个看不到根上的这些文件
  huge: '跑一遍官方桌面端请求回放',
  // build-01 上的 infra：干净的仓库
  clean: '轮换构建机的磁盘',
  // 不属于任何项目，工作目录不是仓库，harness 声明了会给本回合的差异
  loose: '查一下 launchd 的 KeepAlive 语义',
  // nas：起不了进程；gpu-box：没连上
  noSpawn: '整理快照保留策略',
  offline: '评测脚本并行化',
}

/** 真的夹具里说了“改个文件”之后，假模型会接着写、新写的那两个文件（见 scripts/client-fixture-edit.mjs） */
const EDITED = { appended: 'agent-notes.txt', created: 'agent-new.ts' }
/** 起验收的脚本看到 LITCH_SIGNAL diff-many 之后往仓库里摆这么多个文件（见 scripts/check-diff.mjs） */
const MANY_FILES = 300

/** 窗口放到这么宽，侧面板才拖得到“文件那一栏放左边还够并排”的宽度（侧栏 300、对话至少 380、面板 780 往上） */
const ROOMY_WIDTH = 1600

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

/**
 * 开发时看样子用：设了 LITCH_DIFF_SHOTS（一个目录）就在几个地方各截一张图存进去。
 * 平时不设，验收里不截图；截出来的图不进仓库。
 */
const shotsDir = process.env.LITCH_DIFF_SHOTS
async function shot(window: BrowserWindow, name: string): Promise<void> {
  if (!shotsDir) return
  mkdirSync(shotsDir, { recursive: true })
  const image = await window.webContents.capturePage()
  if (!image.isEmpty()) writeFileSync(join(shotsDir, `${name}.png`), image.toPNG())
}

/** 把外观换成指定的那一套（只在截图时用） */
async function lookTo(skin: string, theme: string): Promise<void> {
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  ;(
    window as unknown as { __litchLook: { set(patch: { skin: string; theme: string }): void } }
  ).__litchLook.set({ skin, theme })
  await frame()
  await new Promise<void>((done) => setTimeout(done, 200))
}

/** 摆出写批注的样子（只在截图时用）：edit 点开写批注的框，save 存下，clear 清掉 */
async function notesDemo(phase: string): Promise<void> {
  const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const one = (selector: string) => document.querySelector<HTMLElement>(selector)
  if (phase === 'edit') {
    // 挑眼前看得见的行
    const pane = one('.dp')?.getBoundingClientRect()
    const picks = [
      ...document.querySelectorAll<HTMLElement>('.dp button.dn-pick[data-side="next"]'),
    ].filter((pick) => {
      const box = pick.getBoundingClientRect()
      return pane !== undefined && box.top > pane.top + 120 && box.bottom < pane.bottom - 200
    })
    picks[1]?.click()
    await pause(100)
    picks[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await pause(200)
    const input = one('.dnote-edit textarea') as HTMLTextAreaElement | null
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        input,
        '这几行换个写法，别在这里直接改状态',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  } else if (phase === 'save') one('[data-act="note-save"]')?.click()
  else one('.cmp-notes-x')?.click()
  await pause(300)
}

/** 把视图换成并排或者合并（只在截图时用） */
async function layoutTo(layout: string): Promise<void> {
  const pane = () => document.querySelector<HTMLElement>('.dp')
  if (pane()?.dataset.layout !== layout) {
    document.querySelector<HTMLElement>('.db [data-tool="layout"]')?.click()
  }
  await new Promise<void>((done) => setTimeout(done, 300))
}

async function shotLooks(window: BrowserWindow, name: string): Promise<void> {
  if (!shotsDir) return
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      await inPage(window, lookTo, skin, theme)
      await shot(window, `${name}-${skin}-${theme}`)
    }
  }
  await inPage(window, lookTo, 'retro', 'dark')
}

async function runMock(window: BrowserWindow): Promise<MockSeen> {
  await inPage(window, installFilesKit)
  await inPage(window, installDiffKit)
  const basics = await inPage(window, mockBasics, MOCK.home)
  await shot(window, 'mock-split')
  await shotLooks(window, 'look-split')
  const writes = await inPage(window, mockWrites)
  const turn = await inPage(window, mockTurn)
  await shot(window, 'mock-after-turn')
  const notes = await inPage(window, mockNotes, MOCK.home, MOCK.tools)
  if (shotsDir) {
    await inPage(window, notesDemo, 'edit')
    await shot(window, 'mock-note-editor')
    await inPage(window, notesDemo, 'save')
    await shot(window, 'mock-note-card')
    await inPage(window, notesDemo, 'clear')
  }
  const many = await inPage(window, mockMany, MOCK.many)
  await shot(window, 'mock-many')
  const places = await inPage(window, mockPlaces, {
    huge: MOCK.huge,
    clean: MOCK.clean,
    loose: MOCK.loose,
    noSpawn: MOCK.noSpawn,
    offline: MOCK.offline,
  })
  await shot(window, 'mock-offline')
  // 窗口缩到允许的最窄最矮：文件那一栏挪到内容上面，只能合并着看
  const [width = 0, height = 0] = window.getSize()
  const [minWidth = 0, minHeight = 0] = window.getMinimumSize()
  window.setSize(minWidth, minHeight)
  const [inner = 0] = window.getContentSize()
  const narrow = await inPage(window, narrowSeen, MOCK.home, inner)
  await shot(window, 'mock-narrow')
  // 窗口放宽：面板拖得够宽了，文件那一栏回到左边。屏幕没有这么宽就放不到，那就不量这一项（照实报）
  window.setSize(ROOMY_WIDTH, height)
  const [roomyInner = 0] = window.getContentSize()
  const roomy =
    roomyInner >= ROOMY_WIDTH ? await inPage(window, roomySeen, MOCK.home, roomyInner) : null
  await shot(window, 'mock-roomy')
  window.setSize(width, height)
  const look = await inPage(window, diffLook, MOCK.home)
  if (shotsDir) {
    await inPage(window, layoutTo, 'unified')
    await shotLooks(window, 'look-unified')
    await inPage(window, layoutTo, 'split')
  }
  return { basics, writes, turn, notes, many, places, narrow, roomy, look }
}

async function runReal(window: BrowserWindow, mode: DiffMode): Promise<RealSeenAll> {
  // 两种夹具里工作目录是项目根的会话
  const session = mode === 'diff-device' ? '给列表加上分页' : '逐个检查一百多个文件'
  await inPage(window, installFilesKit)
  await inPage(window, installDiffKit)
  const main = await inPage(window, realDiff, {
    session,
    // 没起名字的那个会话，工作目录在另一个目录里，那里不是仓库
    other: '帮我想三个周报的小标题',
    ...EDITED,
  })
  await shot(window, `${mode}-main`)
  const many = await inPage(window, realMany, MANY_FILES)
  await shot(window, `${mode}-many`)
  return { main, many }
}

async function run(window: BrowserWindow, mode: DiffMode): Promise<readonly [object, string[]]> {
  if (mode === 'diff') {
    const seen = await runMock(window)
    return [{ ...seen, lenient, numbers: mockNumbers(seen) }, judgeMock(seen, lenient)]
  }
  const seen = await runReal(window, mode)
  return [
    { ...seen, lenient, numbers: realNumbers(seen) },
    judgeReal(seen, { ...EDITED, many: MANY_FILES }, lenient),
  ]
}

/** 到点还没跑完：走到哪一步、页面当时什么样（页面答得上来的话） */
async function overdue(window: BrowserWindow, mode: DiffMode): Promise<string> {
  const page = await Promise.race([
    window.webContents
      .executeJavaScript(
        `(${(() => (window as unknown as { __diffKit?: DiffKit }).__diffKit?.where() ?? '页面里还没装上验收的工具').toString()})()`,
        true,
      )
      .catch((error: unknown) => `页面问不到：${String(error)}`),
    new Promise<string>((done) => setTimeout(() => done('页面三秒没有应答'), 3000)),
  ])
  return `验收跑了 ${DEADLINE_MS[mode] / 1000} 秒还没完。走过的步骤：${steps.join(' → ')}。页面：${String(page)}`
}

export async function runDiffChecks(
  window: BrowserWindow,
  mode: DiffMode,
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
      run(window, mode).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}（走过的步骤：${steps.join(' → ')}）`)
      }),
      late,
    ])
  } finally {
    clearTimeout(stop)
  }
}
