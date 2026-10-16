// 终端验收里对着真 shell 的后几段：关标签的两种意思落到设备上是什么（设备夹具），
// 和随连接结束的终端断线之后怎么样（单个 harness 的入口）。前几段在 probe-terminal-device.mts。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface DeviceClose {
  /** 点叉选“结束”的那个终端的代号（也是它在设备上的进程句柄）：起验收的脚本从外面核对它真的没了 */
  ended: string
  endedGone: boolean
  /** 点叉选“留着”的那个：标签没了，列在“设备上的终端”里，脚本从外面核对它还在跑 */
  left: string
  leftGone: boolean
  stowedShown: string
  /** 剩下的标签 */
  tabs: string[]
}

export async function deviceClose(): Promise<DeviceClose> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text } = kit
  const closeButton = (index: number) => all('.term-tab .term-x > button')[index]

  // 第二个：结束
  const ended = kit.tabs()[1]?.id ?? ''
  closeButton(1)?.click()
  const pop = await until('问怎么关', () => one('.term-close'))
  one<HTMLButtonElement>('[data-choice="end"]', pop)?.click()
  await until('结束了', () => kit.tabs().every((tab) => tab.id !== ended))
  // 反面的事：过几帧再看它有没有冒出来
  for (let count = 0; count < 4; count++) await kit.frame()
  const endedGone = !one('.term-stowed > button')

  // 新开一个，让它跑着一个要很久的命令，再选“留着”
  one<HTMLButtonElement>('.term-new')?.click()
  await until('新开了一个', () => kit.tabs().length === 2)
  await until('它上台了', () => kit.tabs()[1]?.active)
  await kit.prompt(30_000)
  kit.run('echo go-$((3+1)); sleep 600')
  await kit.see('命令跑起来了', /\ngo-4/)
  const left = kit.tabs()[1]?.id ?? ''
  closeButton(1)?.click()
  const again = await until('再问一次', () => one('.term-close'))
  one<HTMLButtonElement>('[data-choice="leave"]', again)?.click()
  await until('收起了', () => kit.tabs().every((tab) => tab.id !== left))
  const leftGone = kit.tabs().length === 1
  const stowed = await until('设备上的终端', () => one<HTMLButtonElement>('.term-stowed > button'))
  return {
    ended,
    endedGone,
    left,
    leftGone,
    stowedShown: text(stowed),
    tabs: kit.tabs().map((tab) => tab.id),
  }
}

/**
 * 现在开成标签的那些终端的代号。expect：应该剩几个，等到是这个数再读（一直不是也照实读）；
 * 不给的话是在看“没变”，过几帧再读
 */
export async function tabIds(expect?: number): Promise<string[]> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  if (expect === undefined) for (let count = 0; count < 6; count++) await kit.frame()
  else await kit.seen(() => kit.tabs().length === expect, 5000)
  return kit.tabs().map((tab) => tab.id)
}

export interface EntryDrop {
  /** 关还在跑的、随连接结束的终端：没有“留着”这一项，焦点落在“不关了”上 */
  choices: string[]
  askFocus: string
  /** 断线之后：标签和内容留着，说明它跟着连接结束了；没连上的时候不能重开 */
  lostNote: string
  contentKept: boolean
  restartOffline: boolean
  deaf: boolean
  /** 连回来之后在同一个标签里重开：是一个新的 shell，能用 */
  sameTab: boolean
  restarted: boolean
  /** 重开之后敲的那条命令没等到结果时，屏幕上最后几行是什么（等到了就是空的） */
  restartTail: string
  fresh: boolean
}

export async function entryDrop(): Promise<EntryDrop> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text } = kit
  const before = kit.tabs()[0]?.id ?? ''

  all('.term-tab .term-x > button')[0]?.click()
  const pop = await until('问怎么关', () => one('.term-close'))
  // 焦点是浮层画出来之后才放上去的
  await kit.seen(() => pop.contains(document.activeElement), 3000)
  const choices = all('[data-choice]', pop).map((entry) => entry.dataset.choice ?? '')
  const askFocus = (document.activeElement as HTMLElement | null)?.dataset.choice ?? ''
  one<HTMLButtonElement>('[data-choice="cancel"]', pop)?.click()
  await until('不关了', () => !one('.term-close'))

  kit.run('echo kept-$((7*7))')
  await kit.see('记号', /\nkept-49/)
  await kit.prompt()
  kit.signal('link down')
  const strip = await until('标成已断开', () => one('.term-status[data-state="lost"]'), 30_000)
  const lostNote = text(one('span', strip))
  const contentKept = kit.rows().includes('kept-49')
  // 状态条跟的是终端的状态，按钮停不停用跟的是设备连没连上：两条订阅各发各的，可以差一帧。
  // 所以等它停用，不在状态条刚出现的那一帧读（流水线上就在那一帧读到过“还能点”）
  const restartOffline = await kit.seen(
    () => one<HTMLButtonElement>('.term-status [data-tool="restart"]')?.disabled === true,
    3000,
  )
  // 状态条占了终端底下两行的地方，终端这时候正在按新的高度重排：不能拿敲键前后的整屏去比
  const deaf = await kit.deaf()

  kit.signal('link up')
  const button = await until(
    '连回来了，能重开',
    () => {
      const found = one<HTMLButtonElement>('.term-status [data-tool="restart"]')
      return found && !found.disabled ? found : null
    },
    90_000,
  )
  button.click()
  await until('重开了', () => !one('.term-status') && kit.tabs()[0]?.state === 'running', 30_000)
  await kit.prompt(30_000)
  const sameTab = kit.tabs().length === 1 && kit.tabs()[0]?.id === before
  const fresh = !kit.screen().includes('kept-49')
  kit.run('echo again-$((8*8))')
  await kit.see('重开之后能用', /\nagain-64/, 30_000).catch(() => {})
  const restarted = /\nagain-64/.test(kit.screen())
  const restartTail = restarted
    ? ''
    : kit
        .rows()
        .filter((row) => row.trim() !== '')
        .slice(-4)
        .join(' ⏎ ')
  await kit.prompt()
  return {
    choices,
    askFocus,
    lostNote,
    contentKept,
    restartOffline,
    deaf,
    sameTab,
    restarted,
    restartTail,
    fresh,
  }
}

export interface FloodRound {
  /** 刷屏期间的帧间隔（毫秒）：中位数、95 分位、最长 */
  frames: number
  median: number
  p95: number
  max: number
  /** 这期间屏幕在动的帧数、终端里说过几次“略过了输出” */
  moved: number
  gaps: number
  /** 按中断键到提示符回来（毫秒） */
  interruptMs: number
  interrupted: boolean
  /** 停下来之后还能接着用 */
  usable: boolean
}

export interface RealFlood {
  /** 界面跟得上的速度（seq 数数，一秒一两兆）：不该略过什么 */
  steady: FloodRound
  /** 比界面快得多（yes 接 cat -n，一秒几十兆以上）：略过是应该的，界面不能卡，中断要生效 */
  burst: FloodRound
}

export async function realFlood(): Promise<RealFlood> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, frame, sleep } = kit
  const noted = () => Number(one('.term-host.on')?.dataset.gaps ?? 0)
  let turn = 0
  // 两种命令每一行都不一样（行首是行号），所以看得出屏幕在不在动；都不会自己停，验收里按中断键停
  const round = async (command: string): Promise<FloodRound> => {
    const gapsBefore = noted()
    kit.run(command)
    await until('开始刷了', () => kit.rows().filter((row) => /^\s*\d+/.test(row)).length > 5)
    const gaps: number[] = []
    let moved = 0
    let last = performance.now()
    let lastTop = ''
    const watchEnd = last + 2500
    while (performance.now() < watchEnd) {
      await frame()
      const now = performance.now()
      gaps.push(now - last)
      last = now
      const top = kit.rows()[0] ?? ''
      if (top !== lastTop) moved++
      lastTop = top
    }
    gaps.sort((a, b) => a - b)
    const at = (share: number) =>
      gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * share))] ?? 0
    const started = performance.now()
    kit.ctrl('c')
    await until('中断生效', () => /[$%#]$/.test(kit.lastLine()), 60_000)
    const interruptMs = performance.now() - started
    const settled = kit.rows().join('\n')
    await sleep(500)
    const interrupted = kit.rows().join('\n') === settled
    turn++
    kit.run(`echo calm-$((${turn}+100))`)
    const calm = new RegExp(`\\ncalm-${turn + 100}`)
    await kit.see('停下来之后能用', calm, 30_000).catch(() => {})
    const usable = calm.test(kit.screen())
    await kit.prompt()
    return {
      frames: gaps.length,
      median: at(0.5),
      p95: at(0.95),
      max: gaps.at(-1) ?? 0,
      moved,
      gaps: noted() - gapsBefore,
      interruptMs,
      interrupted,
      usable,
    }
  }
  const steady = await round('seq 1 100000000')
  const burst = await round('yes 0123456789abcdefghijklmnopqrstuvwxyz | cat -n')
  return { steady, burst }
}
