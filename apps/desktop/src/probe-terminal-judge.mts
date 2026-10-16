// 终端验收（模拟核心那一种）量到的东西合不合格。线划在哪、为什么，写在各条旁边。
import type { MockBasics } from './probe-terminal.mjs'
import type { MockFlow, MockHome } from './probe-terminal-flow.mjs'
import type { LookSeen, MockClose } from './probe-terminal-look.mjs'
import type { HeightSeen, SizeSeen } from './probe-terminal-size.mjs'
import type { QuitOutcome } from './quit-terminals.mjs'

/**
 * 时间上的线。严的一套只在够快的机器上划（开发用的机器）：
 * - 敲一个键到它显示出来，超过 120 毫秒就是迟钝了（实测三十几）；
 * - 刷屏的时候两帧之间，中位数过了 34 就是掉到三十帧以下，最长的一次过了半秒就是卡了一下；
 * - 刷屏的时候切到别的标签敲命令、按中断键，2 秒还没反应就算没生效。
 * 宽的一套给慢机器（流水线的虚拟机，或者 LITCH_CHECK_LENIENT=1）：回显和帧间隔只报数不划线，
 * 只留“卡死了”的线，比严的宽十倍上下：一帧 5 秒、反应 20 秒。刷屏真把界面堵住的话，一帧会是整段刷屏那么长，照样拦得住。
 */
export interface TimeLines {
  echoMs: number | null
  frameMedianMs: number | null
  frameP95Ms: number | null
  frameMaxMs: number
  reactMs: number
  /** 刷屏那两秒半里屏幕至少要变这么多次（看的是它一直在动，不是憋到最后才出来） */
  moved: number
}

export const STRICT_LINES: TimeLines = {
  echoMs: 120,
  frameMedianMs: 34,
  frameP95Ms: 100,
  frameMaxMs: 500,
  reactMs: 2000,
  moved: 20,
}

export const LENIENT_LINES: TimeLines = {
  echoMs: null,
  frameMedianMs: null,
  frameP95Ms: null,
  frameMaxMs: 5000,
  reactMs: 20_000,
  moved: 4,
}

export interface WindowSize {
  width: number
  height: number
  seen: SizeSeen
}

export interface QuitSeen {
  /** 清点之前开着几个标签 */
  before: string[]
  cancel: QuitOutcome
  afterCancel: string[]
  leave: QuitOutcome
  afterLeave: string[]
  end: QuitOutcome
  afterEnd: string[]
}

export interface MockSeen {
  basics: MockBasics
  flow: MockFlow
  close: MockClose
  sizes: WindowSize[]
  height: HeightSeen
  look: LookSeen
  quit: QuitSeen
  home: MockHome
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export function mockNumbers(seen: MockSeen): string {
  const { basics, flow } = seen
  const ms = (value: number) => `${value.toFixed(1)} ms`
  return [
    `按键到回显 ${ms(median(basics.echoMs))}（${ms(Math.min(...basics.echoMs))}–${ms(Math.max(...basics.echoMs))}）`,
    `刷屏时帧间隔 中位 ${ms(flow.floodMedian)}、95 分位 ${ms(flow.floodP95)}、最长 ${ms(flow.floodMax)}（${flow.floodFrames} 帧）`,
    `刷屏时切标签到出结果 ${ms(flow.switchMs)}`,
    `中断生效 ${ms(flow.interruptMs)}`,
  ].join('；')
}

export function judgeMock(seen: MockSeen, lenient: boolean): string[] {
  const { basics, flow, close, sizes, height, look, quit, home } = seen
  const lines = lenient ? LENIENT_LINES : STRICT_LINES
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }

  // ---------- 开合、输入、标签 ----------
  must(basics.startsClosed, '面板一开始应该是收着的')
  must(
    basics.opened && basics.firstTab === '终端 1',
    `打开面板没有顺手开出“终端 1”（${basics.firstTab}）`,
  )
  must(basics.focused, '打开面板之后焦点不在终端里')
  must(basics.welcome, '新开的终端没有停在提示符上')
  must(basics.echoed, '敲的命令没有结果')
  must(
    lines.echoMs === null || median(basics.echoMs) <= lines.echoMs,
    `按键到回显太慢：中位 ${median(basics.echoMs).toFixed(1)} ms，线是 ${lines.echoMs} ms`,
  )
  must(basics.cjk, '中文和表情没有原样回显')
  must(basics.wideOffset < 1, `宽字符没有占两格：和尺子差了 ${basics.wideOffset.toFixed(2)} 像素`)
  must(basics.linkShown, '网址没有画成能点的')
  must(
    basics.tabNames.join('|') === '终端 1|终端 2' && basics.secondActive,
    `新开第二个之后标签不对：${basics.tabNames.join('|')}`,
  )
  // 一共 12 步。一下子全出来的话只看得到头尾两种步数；看到过四种以上就是一步一步出来的
  must(
    basics.slowDone && basics.slowSteps.length >= 4,
    `慢慢出字不是逐步显示的：看到的步数 ${basics.slowSteps.join(',')}`,
  )
  must(basics.firstKept, '切回第一个标签，内容不在了')
  must(basics.renamed === '构建', `改名没生效：${basics.renamed}`)
  must(basics.renameCancelled, '按 Esc 取消改名，名字却变了')
  must(basics.cleared, '清屏之后屏幕上不止一个提示符')
  must(basics.usableAfterClear, '清屏之后不能接着用')

  // ---------- 内容和滚到哪了 ----------
  must(flow.scrolled, '往回翻没有翻动')
  must(flow.keptAcrossTabs, '切到别的标签再回来，滚到的位置变了')
  must(flow.keptAcrossPanel, '收起面板再打开，滚到的位置变了')
  must(flow.keptAcrossSession, '换到别的项目的会话再回来，滚到的位置变了')
  must(flow.keptAcrossPage, '开“设备”页再回来，滚到的位置变了')
  must(flow.otherGroupEmpty, '别的项目的会话里看到的不是它自己那一组终端')
  must(flow.hiddenOnPage, '开着“设备”页的时候面板还显示着')

  // ---------- 刷屏 ----------
  must(
    flow.floodMoved >= lines.moved,
    `刷屏的时候屏幕没怎么动：只变了 ${flow.floodMoved} 次，线是 ${lines.moved} 次`,
  )
  must(
    lines.frameMedianMs === null || flow.floodMedian <= lines.frameMedianMs,
    `刷屏时帧间隔的中位数 ${flow.floodMedian.toFixed(1)} ms，线是 ${lines.frameMedianMs} ms`,
  )
  must(
    lines.frameP95Ms === null || flow.floodP95 <= lines.frameP95Ms,
    `刷屏时帧间隔的 95 分位 ${flow.floodP95.toFixed(1)} ms，线是 ${lines.frameP95Ms} ms`,
  )
  must(
    flow.floodMax <= lines.frameMaxMs,
    `刷屏时最长的一帧 ${flow.floodMax.toFixed(1)} ms，线是 ${lines.frameMaxMs} ms`,
  )
  must(
    flow.switchMs <= lines.reactMs,
    `刷屏时切到别的标签敲命令，${flow.switchMs.toFixed(0)} ms 才出结果，线是 ${lines.reactMs} ms`,
  )
  must(flow.interrupted, '刷屏按了中断键没有停下来')
  must(
    flow.interruptMs <= lines.reactMs,
    `中断键 ${flow.interruptMs.toFixed(0)} ms 才生效，线是 ${lines.reactMs} ms`,
  )
  must(flow.gapsNoted > 0, '刷屏比界面处理得快，终端里却没有说过略过了输出')

  // ---------- 全屏程序 ----------
  must(flow.fullEntered, '全屏程序没有占满屏幕')
  must(flow.fullTicked, '全屏程序的画面没有在更新')
  must(flow.fullRestored, '退出全屏程序之后，原来的屏幕没有恢复')

  // ---------- 关标签、退出、重开 ----------
  must(
    close.askFocus === 'leave',
    `关还在运行的终端，焦点应该落在“留着”上（现在是 ${close.askFocus}）`,
  )
  must(
    close.choices.join('|') === 'leave|end|cancel',
    `关标签时给的选项不对：${close.choices.join('|')}`,
  )
  must(close.leftGone, '选了“留着”，标签还在')
  must(close.stowedShown.endsWith('· 1'), `没有“设备上的终端”的入口（${close.stowedShown}）`)
  must(close.leftToast, '选了“留着”，没有说它去哪了')
  must(close.broughtBack, '接回来之后“设备上的终端”里还列着它')
  must(close.contentKept, '接回来的终端里内容不在了')
  must(close.endedGone, '选了“结束”，它还列在“设备上的终端”里')
  must(close.exitedNote.includes('3'), `退出之后没有说明退出码（${close.exitedNote}）`)
  must(close.deaf, '已退出的终端敲键还有反应')
  must(close.restartedFresh, '已退出的终端在同一个标签里重开之后，还是原来的屏幕')
  must(close.closedDirectly, '已退出的终端点叉还要问')
  must(close.emptyShown, '都关完之后没有空的状态')

  // ---------- 行列数 ----------
  for (const { width, height, seen: size } of sizes) {
    must(
      size.told === `${size.rows} ${size.cols}`,
      `窗口 ${width}×${height}：程序看到的是 ${size.told}，屏幕上是 ${size.rows} 行 ${size.cols} 列`,
    )
  }
  must(
    new Set(sizes.map(({ seen: size }) => size.told)).size === sizes.length,
    `改了窗口大小，行列数没有跟着变：${sizes.map(({ seen: size }) => size.told).join('、')}`,
  )

  // ---------- 调面板的高度 ----------
  must(
    height.afterKeys === height.before + 72 && height.rowsAfterKeys > height.rowsBefore,
    `用方向键调高面板：${height.before} → ${height.afterKeys} 像素，${height.rowsBefore} → ${height.rowsAfterKeys} 行`,
  )
  must(height.saved === height.afterKeys, `面板的高度没有记下来（记的是 ${height.saved}）`)
  must(
    height.afterDrag === height.afterKeys - 48,
    `拖顶边往下 48 像素：${height.afterKeys} → ${height.afterDrag} 像素`,
  )
  must(
    height.told.split(' ')[0] === String(height.rowsAfterDrag),
    `调过高度之后程序看到 ${height.told}，屏幕上是 ${height.rowsAfterDrag} 行`,
  )

  // ---------- 皮肤与语言 ----------
  const looks = look.looks.map((line) => line.split('｜'))
  must(looks.length === 6, `没有量满六套外观：${looks.length}`)
  for (const [name = '', back, fore, wantBack, wantFore, font = '', wantFont] of looks) {
    must(back === wantBack, `${name}：终端的底色是 ${back}，皮肤要的是 ${wantBack}`)
    must(fore === wantFore, `${name}：终端的字色是 ${fore}，皮肤要的是 ${wantFore}`)
    must(
      font.length > 0 && font === wantFont,
      `${name}：终端的字体是 ${font}，皮肤的等宽字体是 ${wantFont}`,
    )
  }
  must(
    new Set(looks.map(([, back, fore]) => `${back}/${fore}`)).size === 6,
    '六套外观下终端的配色有重复的',
  )
  must(
    look.english.join('|') === 'Terminal 1|Clear|Terminal|New terminal',
    `英文界面下的字不对：${look.english.join('|')}`,
  )
  must(
    look.chinese.join('|') === '终端 1|清屏|终端|新开终端',
    `中文界面下的字不对：${look.chinese.join('|')}`,
  )

  // ---------- 退出前的清点 ----------
  const running = quit.before.filter((tab) => tab.endsWith(':running')).length
  must(running === 2, `清点之前应该有两个终端在跑：${quit.before.join('、')}`)
  must(
    quit.cancel.asked && !quit.cancel.proceed && quit.cancel.alive?.durable === running,
    `退出时选“取消”：${JSON.stringify(quit.cancel)}`,
  )
  must(quit.afterCancel.join() === quit.before.join(), '选了“取消”，终端却变了')
  must(
    quit.leave.proceed && quit.leave.did === 'leave',
    `退出时选“留着”：${JSON.stringify(quit.leave)}`,
  )
  must(quit.afterLeave.join() === quit.before.join(), '选了“留着”，终端却变了')
  must(quit.end.proceed && quit.end.did === 'end', `退出时选“结束”：${JSON.stringify(quit.end)}`)
  must(quit.afterEnd.length === 0, `选了“结束”，还剩着终端：${quit.afterEnd.join('、')}`)

  // ---------- 新建对话页：面板跟着页上选的设备和项目走 ----------
  must(home.start === 'local/', `新建对话页上面板不是默认去处的那一组：${home.start}`)
  must(home.afterDevice === 'build/', `在页上换了设备，面板没有跟着换：${home.afterDevice}`)
  must(
    home.afterWorkspace === home.wanted && home.wanted !== 'build/',
    `在页上换了项目，面板没有跟着换：${home.afterWorkspace}，该是 ${home.wanted}`,
  )
  must(home.back === 'local/', `换回本机，面板没有回到原来那一组：${home.back}`)
  return failed
}
