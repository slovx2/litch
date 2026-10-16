// 终端验收对着真 shell 的两种（设备夹具、单个 harness 的入口）量到的东西合不合格。
import type { DeviceDrop, RealBasics, Restored, TabsMade } from './probe-terminal-device.mjs'
import type { DeviceClose, EntryDrop, FloodRound, RealFlood } from './probe-terminal-ends.mjs'
import {
  LENIENT_LINES,
  STRICT_LINES,
  type TimeLines,
  type WindowSize,
} from './probe-terminal-judge.mjs'
import type { QuitOutcome } from './quit-terminals.mjs'

/**
 * 时间上的线和模拟核心那一种是同一套（probe-terminal-judge.mts），两处不一样：
 * 端到端的回显要过设备和真 shell，线放到 200 毫秒（实测三十几）；中断要等 shell 把进程停掉，放到 3 秒。
 * 宽的那一套照旧只拦“卡死了”。
 */
const linesFor = (lenient: boolean): TimeLines =>
  lenient ? LENIENT_LINES : { ...STRICT_LINES, echoMs: 200, reactMs: 3000 }

export interface DeviceSeen {
  basics: RealBasics
  sizes: WindowSize[]
  flood: RealFlood
  drop: DeviceDrop
  made: TabsMade
  restored: Restored
  close: DeviceClose
  /** 退出时选“结束”：之前开着的标签、清点的结果、之后剩下的标签 */
  beforeEnd: string[]
  end: QuitOutcome
  afterEnd: string[]
  beforeLeave: string[]
  leave: QuitOutcome
  afterLeave: string[]
  /** 给起验收的脚本从外面核对用：这些进程应当已经不在设备上了、这些应当还在跑 */
  outside: { gone: string[]; kept: string[] }
}

export interface EntrySeen {
  basics: RealBasics
  sizes: WindowSize[]
  flood: RealFlood
  drop: EntryDrop
  cancel: QuitOutcome
  leave: QuitOutcome
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export function realNumbers(basics: RealBasics, flood: RealFlood): string {
  const ms = (value: number) => `${value.toFixed(1)} ms`
  const { echoMs } = basics
  const said = (name: string, round: FloodRound) =>
    `${name}：帧间隔 中位 ${ms(round.median)}、95 分位 ${ms(round.p95)}、最长 ${ms(round.max)}（${round.frames} 帧），` +
    `说过 ${round.gaps} 次略过，中断生效 ${ms(round.interruptMs)}`
  return [
    `按键到回显（端到端）${ms(median(echoMs))}（${ms(Math.min(...echoMs))}–${ms(Math.max(...echoMs))}）`,
    said('seq 刷屏', flood.steady),
    said('yes 刷屏', flood.burst),
  ].join('；')
}

/** 真 shell 里刷屏：界面不卡死、能中断 */
function judgeFlood(flood: RealFlood, lines: TimeLines, failed: string[]): void {
  const rounds: [string, FloodRound][] = [
    ['seq 刷屏', flood.steady],
    ['yes 刷屏', flood.burst],
  ]
  for (const [name, round] of rounds) {
    const must = (ok: boolean, what: string) => {
      if (!ok) failed.push(`${name}：${what}`)
    }
    must(
      round.moved >= lines.moved,
      `屏幕没怎么动，只动了 ${round.moved} 帧，线是 ${lines.moved} 帧`,
    )
    must(
      lines.frameMedianMs === null || round.median <= lines.frameMedianMs,
      `帧间隔的中位数 ${round.median.toFixed(1)} ms，线是 ${lines.frameMedianMs} ms`,
    )
    must(
      lines.frameP95Ms === null || round.p95 <= lines.frameP95Ms,
      `帧间隔的 95 分位 ${round.p95.toFixed(1)} ms，线是 ${lines.frameP95Ms} ms`,
    )
    must(
      round.max <= lines.frameMaxMs,
      `最长的一帧 ${round.max.toFixed(1)} ms，线是 ${lines.frameMaxMs} ms`,
    )
    must(round.interrupted, '按了中断键没有停下来')
    must(
      round.interruptMs <= lines.reactMs,
      `中断键 ${round.interruptMs.toFixed(0)} ms 才生效，线是 ${lines.reactMs} ms`,
    )
    must(round.usable, '停下来之后终端不能接着用')
  }
  // 略过了几次只报数、不划线：真 shell 一秒能出多少要看对面那条路有多快（单个 harness 的入口有时界面就跟得上），
  // “比界面快”的那条路在模拟核心的验收里是一定走到的
}

/** 两种都要看的：开得起来、目录对、能输入、全屏程序、行列数 */
function judgeBasics(
  basics: RealBasics,
  sizes: WindowSize[],
  lines: TimeLines,
  failed: string[],
): void {
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(basics.firstTab === '终端 1', `打开面板没有顺手开出“终端 1”（${basics.firstTab}）`)
  must(basics.cwdShown.length > 0, '标签栏上没有写终端开在哪个目录')
  // 临时目录在 macOS 上是个符号链接，shell 说的是解开之后的路径
  must(
    basics.pwd === basics.cwdShown || basics.pwd === `/private${basics.cwdShown}`,
    `终端开在 ${basics.pwd}，标签栏上写的是 ${basics.cwdShown}`,
  )
  must(basics.echoed, '敲的命令没有结果')
  must(
    lines.echoMs === null || median(basics.echoMs) <= lines.echoMs,
    `按键到回显太慢：中位 ${median(basics.echoMs).toFixed(1)} ms，线是 ${lines.echoMs} ms`,
  )
  must(basics.fullEntered, '全屏程序（less）没有占满屏幕')
  must(basics.fullPaged, '全屏程序里翻页，翻过去的行数不是一屏')
  must(basics.fullRestored, '退出全屏程序之后，原来的屏幕没有恢复')
  for (const { width, height, seen: size } of sizes) {
    must(
      size.told === `${size.rows} ${size.cols}`,
      `窗口 ${width}×${height}：stty size 说 ${size.told}，屏幕上是 ${size.rows} 行 ${size.cols} 列`,
    )
  }
  must(
    new Set(sizes.map(({ seen: size }) => size.told)).size === sizes.length,
    `改了窗口大小，行列数没有跟着变：${sizes.map(({ seen: size }) => size.told).join('、')}`,
  )
}

export function judgeDevice(seen: DeviceSeen, lenient: boolean): string[] {
  const { basics, sizes, drop, made, restored, close } = seen
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  judgeBasics(basics, sizes, linesFor(lenient), failed)
  judgeFlood(seen.flood, linesFor(lenient), failed)
  must(!basics.ephemeralPill, '属于设备的终端不该标“随连接结束”')

  // ---------- 断线再连回 ----------
  must(drop.awayNote.includes('自动接回'), `断线之后没有说它还在设备上跑（${drop.awayNote}）`)
  must(drop.contentKept, '断线之后终端里的内容不在了')
  must(drop.notYet, '还没连回来，断线期间的输出却已经显示了')
  must(drop.rejoined, '连回来之后状态条还在')
  must(drop.replayedOnce, '断线期间的输出没有正好补一次')
  must(drop.gapsAfterShortDrop === 0, '断线期间的输出都补回来了，却说少了一段')
  must(drop.usable, '接回来之后不能接着用')
  must(drop.gapLine.includes('没能补回来'), '断线期间的输出超过了设备留着的量，终端里没有说明')
  must(
    drop.gapsAfterLongDrop === 1 && drop.backlogLine === '',
    `补回来的时候又略过了输出：说了 ${drop.gapsAfterLongDrop} 次（${drop.backlogLine}）`,
  )
  must(drop.tailShown, '说明后面，设备留着的那部分输出和之后的输出没有显示全')

  // ---------- 核心重启之后恢复成标签 ----------
  must(made.names.join('|') === '构建|终端 2', `重启之前的标签不对：${made.names.join('|')}`)
  must(restored.panelOpen, '重新加载之后面板没有照原样开着')
  must(
    restored.ids.join('|') === made.ids.join('|'),
    `重启之后标签不是原来那几个、或者顺序变了：${restored.ids.join('|')}（原来 ${made.ids.join('|')}）`,
  )
  must(
    restored.names.join('|') === made.names.join('|'),
    `重启之后标签的名字变了：${restored.names.join('|')}`,
  )
  must(
    restored.states.every((state) => state === 'running'),
    `重启之后有标签没接上：${restored.states.join('|')}`,
  )
  must(restored.firstContent && restored.secondContent, '重启之后终端里的内容没有从设备上补回来')
  must(restored.alive, '重启之后接回来的终端不能接着用')

  // ---------- 关标签的两种意思、退出前的清点 ----------
  must(close.endedGone, '选了“结束”，它却列在“设备上的终端”里')
  must(close.leftGone, '选了“留着”，标签还在')
  must(close.stowedShown.endsWith('· 1'), `没有“设备上的终端”的入口（${close.stowedShown}）`)
  must(
    seen.end.asked &&
      seen.end.proceed &&
      seen.end.did === 'end' &&
      seen.end.alive?.durable === seen.beforeEnd.length,
    `退出时选“结束”（当时开着 ${seen.beforeEnd.length} 个）：${JSON.stringify(seen.end)}`,
  )
  must(seen.afterEnd.length === 0, `退出时选了“结束”，还剩着标签：${seen.afterEnd.join('、')}`)
  must(
    seen.leave.proceed && seen.leave.did === 'leave' && seen.leave.alive?.durable === 1,
    `退出时选“留着”：${JSON.stringify(seen.leave)}`,
  )
  must(
    seen.afterLeave.join('|') === seen.beforeLeave.join('|') && seen.beforeLeave.length === 1,
    '退出时选了“留着”，标签却变了',
  )
  return failed
}

export function judgeEntry(seen: EntrySeen, lenient: boolean): string[] {
  const { basics, sizes, drop } = seen
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  judgeBasics(basics, sizes, linesFor(lenient), failed)
  judgeFlood(seen.flood, linesFor(lenient), failed)
  must(basics.ephemeralPill, '随连接结束的终端没有标出来')
  must(
    drop.choices.join('|') === 'cancel|end',
    `关随连接结束的终端，选项应该只有“不关了”和“结束”：${drop.choices.join('|')}`,
  )
  must(drop.askFocus === 'cancel', `焦点应该落在“不关了”上（现在是 ${drop.askFocus}）`)
  must(drop.lostNote.includes('连接断过'), `断线之后没有标成已断开（${drop.lostNote}）`)
  must(drop.contentKept, '断线之后终端里的内容不在了')
  must(drop.restartOffline, '没连上的时候不该能重开')
  must(drop.deaf, '已经断开的终端敲键还有反应')
  must(drop.sameTab, '重开不是在同一个标签里')
  must(drop.fresh, '重开之后还是原来的屏幕')
  must(drop.restarted, `重开之后不能用（屏幕最后几行：${drop.restartTail}）`)
  must(
    seen.cancel.asked &&
      !seen.cancel.proceed &&
      seen.cancel.alive?.durable === 0 &&
      seen.cancel.alive?.ephemeral === 1,
    `退出时选“取消”：${JSON.stringify(seen.cancel)}`,
  )
  must(seen.leave.proceed, `退出时选“退出”：${JSON.stringify(seen.leave)}`)
  return failed
}
