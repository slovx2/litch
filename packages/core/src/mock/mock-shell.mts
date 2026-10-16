// 模拟核心里的假 shell：一个提示符、行编辑、几条假命令。给界面开发和验收用，不执行任何真的东西。
// 假命令各对着终端面板的一条路径：
//   slow        慢慢出字，一步一步出，能被中断
//   flood [n]   刷屏：不给行数就一直刷到按中断键；给了就刷 n 行，最后一行是固定的结束语
//   fullscreen  进全屏（备用屏幕）画一个画面，按 q 或中断键退出，窗口大小变了会重画
//   size        现在的行列数（相当于 stty size）
//   wide        中文、全角符号和表情，下面跟一行等宽的尺子
//   link        一个能点的网址
//   colors      十六种颜色
//   echo、clear、exit、help
import type { Clock } from '../channel/protocol.mjs'
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from '../text/bytes.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface ShellIo {
  clock: Clock
  /** “过一会儿”的单位，毫秒。0 表示不拖时间 */
  stepMs: number
  lang: SampleLang
  /** 提示符里的“用户@主机”和目录 */
  host: string
  cwd: string
  size(): { rows: number; cols: number }
  /** 往终端里输出一块：base64 的字节和它的字节数 */
  out(data: string, bytes: number): void
  exit(code: number): void
}

export interface FakeShell {
  /** 键盘来的输入，base64 */
  input(data: string): void
  /** 行列数变了 */
  resized(): void
  stop(): void
}

const ESC = '\u001b'
const CSI = `${ESC}[`

const WORDS = {
  'zh-CN': {
    welcome: 'Litch 的假终端。输入 help 看有哪些命令。',
    help: [
      'slow        慢慢出字',
      'flood [n]   刷屏，不给行数就刷到按 Ctrl+C',
      'fullscreen  进全屏，按 q 退出',
      'size        现在的行列数',
      'wide        中文和表情',
      'link        一个能点的网址',
      'colors      十六种颜色',
      'echo、clear、exit',
    ],
    notFound: (name: string) => `litch-sh: 找不到这个命令：${name}（输入 help 看有哪些）`,
    step: (at: number, total: number) => `第 ${at} 步，共 ${total} 步：正在慢慢出字`,
    done: '做完了。',
    floodDone: (lines: number) => `flood 完成：${lines} 行`,
    fullTitle: '全屏程序（假的）',
    fullHint: '按 q 退出',
    fullTick: (count: number) => `已经刷新 ${count} 次`,
    wide: ['中文宽字符｜全角：ＡＢＣ｜表情：🙂🚀✅', '日本語のテキスト｜한국어 텍스트'],
    link: '文档在这里：',
  },
  en: {
    welcome: 'A pretend terminal from Litch. Type help to see the commands.',
    help: [
      'slow        print slowly',
      'flood [n]   flood the screen; without a count it runs until Ctrl+C',
      'fullscreen  enter full screen, q to quit',
      'size        current rows and columns',
      'wide        CJK text and emoji',
      'link        a clickable address',
      'colors      the sixteen colors',
      'echo, clear, exit',
    ],
    notFound: (name: string) => `litch-sh: command not found: ${name} (type help for the list)`,
    step: (at: number, total: number) => `step ${at} of ${total}: printing slowly`,
    done: 'All done.',
    floodDone: (lines: number) => `flood finished: ${lines} lines`,
    fullTitle: 'A full-screen program (pretend)',
    fullHint: 'press q to quit',
    fullTick: (count: number) => `refreshed ${count} times`,
    wide: ['中文宽字符｜全角：ＡＢＣ｜表情：🙂🚀✅', '日本語のテキスト｜한국어 텍스트'],
    link: 'The docs are here: ',
  },
} as const

/** 刷屏的一行：12 个字节的行号加 84 个字节的正文，一共 96 字节，是 3 的倍数，所以每行可以各自编成 base64 再接起来 */
const FLOOD_BODY = `${'the quick brown fox jumps over the lazy dog 0123456789 '.repeat(2).slice(0, 82)}\r\n`
const FLOOD_BODY_B64 = encodeBase64(encodeUtf8(FLOOD_BODY))
const FLOOD_LINE_BYTES = 96
/**
 * 刷屏的速度，字节每秒。要比界面处理得过来的快，积压和略过的路径才走得到：
 * 实测界面这一头一秒能吃十几兆（每一帧放行一个窗口的量），所以这里给到它的几倍
 */
const FLOOD_RATE = 64 * 1024 * 1024
/** 一次最多出这么多行，免得定时器晚到一次就出一大堆 */
const FLOOD_BURST = 4096

const floodLine = (line: number): string =>
  encodeBase64(encodeUtf8(`${String(line % 1_000_000_000).padStart(9, '0')} | `)) + FLOOD_BODY_B64

/** 这个字在终端里占不占两格。够假 shell 退格时用：东亚文字、全角符号、表情 */
const isWide = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
}

export function createFakeShell(io: ShellIo): FakeShell {
  const words = WORDS[io.lang]
  const step = Math.max(io.stepMs, 1)
  let line = ''
  /** 正在跑的命令：怎么停它、它收不收键盘（全屏程序要收 q） */
  let job: { stop(): void; key?(char: string): void; resized?(): void } | null = null
  let stopped = false

  const write = (text: string) => {
    const bytes = encodeUtf8(text)
    io.out(encodeBase64(bytes), bytes.length)
  }
  const prompt = () => write(`${CSI}32m${io.host}${CSI}0m:${CSI}34m${io.cwd}${CSI}0m$ `)
  const finish = () => {
    job = null
    prompt()
  }

  const slow = () => {
    const total = 12
    let at = 0
    let stopTimer: (() => void) | null = null
    const next = () => {
      stopTimer = null
      at++
      write(`${words.step(at, total)}\r\n`)
      if (at >= total) {
        write(`${words.done}\r\n`)
        finish()
        return
      }
      stopTimer = io.clock.setTimer(next, step * 2)
    }
    job = { stop: () => stopTimer?.() }
    stopTimer = io.clock.setTimer(next, step * 2)
  }

  const flood = (limit: number | null) => {
    let produced = 0
    let last = io.clock.now()
    let stopTimer: (() => void) | null = null
    const tick = () => {
      stopTimer = null
      const now = io.clock.now()
      // 按过去的时间算该出多少行：定时器在浏览器里不准，速度不能跟着它变
      const due = Math.ceil((Math.max(now - last, 1) * FLOOD_RATE) / 1000 / FLOOD_LINE_BYTES)
      last = now
      let lines = Math.min(due, FLOOD_BURST)
      if (limit !== null) lines = Math.min(lines, limit - produced)
      let chunk = ''
      for (let count = 0; count < lines; count++) chunk += floodLine(++produced)
      if (lines > 0) io.out(chunk, lines * FLOOD_LINE_BYTES)
      if (limit !== null && produced >= limit) {
        write(`${words.floodDone(produced)}\r\n`)
        finish()
        return
      }
      stopTimer = io.clock.setTimer(tick, 1)
    }
    job = { stop: () => stopTimer?.() }
    stopTimer = io.clock.setTimer(tick, 1)
  }

  const fullscreen = () => {
    let count = 0
    let stopTimer: (() => void) | null = null
    const paint = () => {
      const { rows, cols } = io.size()
      const bar = '─'.repeat(Math.max(cols - 2, 1))
      write(
        `${CSI}H${CSI}2J${CSI}7m ${words.fullTitle} ${CSI}0m\r\n${bar}\r\n` +
          `${rows} x ${cols}\r\n${CSI}${Math.max(rows, 1)};1H${CSI}2m${words.fullHint}${CSI}0m`,
      )
      status()
    }
    const status = () => write(`${CSI}5;1H${CSI}2K${words.fullTick(count)}`)
    const loop = () => {
      count++
      status()
      stopTimer = io.clock.setTimer(loop, step * 4)
    }
    const leave = () => {
      stopTimer?.()
      // 光标放回来，回到原来的屏幕：进去之前的内容应当原样还在
      write(`${CSI}?25h${CSI}?1049l`)
    }
    // 换到备用屏幕，藏起光标
    write(`${CSI}?1049h${CSI}?25l`)
    paint()
    stopTimer = io.clock.setTimer(loop, step * 4)
    job = {
      stop: leave,
      key(char) {
        if (char !== 'q' && char !== 'Q') return
        leave()
        finish()
      },
      resized: paint,
    }
  }

  const run = (text: string) => {
    const [name = '', ...args] = text.trim().split(/\s+/)
    if (!name) {
      prompt()
      return
    }
    if (name === 'help') write(`${words.help.join('\r\n')}\r\n`)
    else if (name === 'echo') write(`${args.join(' ')}\r\n`)
    else if (name === 'clear') write(`${CSI}H${CSI}2J${CSI}3J`)
    else if (name === 'size') {
      const { rows, cols } = io.size()
      write(`${rows} ${cols}\r\n`)
    } else if (name === 'wide') {
      // 尺子：下面这一行的竖线应当和上面一行的全角竖线对齐在偶数列上
      write(`${words.wide.join('\r\n')}\r\n${'1234567890'.repeat(4)}\r\n`)
    } else if (name === 'link') write(`${words.link}https://example.com/litch/terminal\r\n`)
    else if (name === 'colors') {
      const row = (base: number) =>
        Array.from({ length: 8 }, (_, at) => `${CSI}${base + at}m ${base + at} ${CSI}0m`).join('')
      write(`${row(30)}\r\n${row(90)}\r\n${row(40)}\r\n${row(100)}\r\n`)
    } else if (name === 'exit') {
      const code = Number.parseInt(args[0] ?? '0', 10)
      stopped = true
      io.exit(Number.isFinite(code) ? code & 0xff : 0)
      return
    } else if (name === 'slow') return slow()
    else if (name === 'flood') {
      const count = Number.parseInt(args[0] ?? '', 10)
      return flood(Number.isFinite(count) && count > 0 ? count : null)
    } else if (name === 'fullscreen' || name === 'top') return fullscreen()
    else write(`${words.notFound(name)}\r\n`)
    prompt()
  }

  /** 一个键。命令在跑的时候只认中断键，全屏程序另外认它自己的键 */
  const key = (char: string) => {
    const code = char.codePointAt(0) ?? 0
    if (job) {
      if (code === 3) {
        job.stop()
        write('^C\r\n')
        finish()
      } else job.key?.(char)
      return
    }
    if (code === 13 || code === 10) {
      write('\r\n')
      const text = line
      line = ''
      run(text)
    } else if (code === 3) {
      line = ''
      write('^C\r\n')
      prompt()
    } else if (code === 4) {
      if (line === '') run('exit')
    } else if (code === 12) {
      write(`${CSI}H${CSI}2J`)
      prompt()
      write(line)
    } else if (code === 127 || code === 8) {
      const chars = Array.from(line)
      const last = chars.pop()
      if (last === undefined) return
      line = chars.join('')
      write(isWide(last) ? '\b\b  \b\b' : '\b \b')
    } else if (code >= 32) {
      line += char
      write(char)
    }
  }

  write(`${words.welcome}\r\n`)
  prompt()

  return {
    input(data) {
      if (stopped) return
      const text = decodeUtf8(decodeBase64(data))
      // 方向键这一类转义序列整个吞掉：假 shell 没有光标移动
      const plain = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO.|\u001b./g, '')
      for (const char of plain) {
        if (stopped) return
        key(char)
      }
    },
    resized() {
      job?.resized?.()
    },
    stop() {
      stopped = true
      job?.stop()
      job = null
    },
  }
}
