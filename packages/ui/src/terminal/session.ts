// 一个终端在界面这一头的全部：终端控件、它的输出订阅、输入、行列数。
// 这个对象不归哪个组件管：面板收起、换工作区、换会话、换页面，它都还在，所以内容和滚到哪了都不丢。
//
// 输出怎么进来：核心把字节分批交过来（每批有上限，这边没回报处理完之前它不多给）。
// 这里按原样交给终端控件，控件解析完一批就回报一次（terminal.ack），核心才接着给下一批。
// 所以不管对面输出多快，压在界面这一头的只有有限的一点，主线程不会被堵死；
// 跟不上的那部分在核心里只留末尾，中间略过的地方有记号，在这里变成终端里的一行说明。
import '@xterm/xterm/css/xterm.css'
import {
  type CoreChannel,
  decodeBase64,
  encodeBase64,
  encodeUtf8,
  type TerminalMark,
  type TerminalOp,
  type TerminalState,
  type TerminalStreamView,
} from '@litch/core'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { Look } from './look.ts'

export interface SessionHost {
  channel: CoreChannel
  deviceId: string
  terminalId: string
  /** 一开始的行列数：对面的伪终端现在是多大，补回来的内容才排得和当时一样 */
  rows: number
  cols: number
  look: Look
  /** 是不是 macOS：复制粘贴的键位不一样 */
  mac: boolean
  /** 只有 http 和 https 的会到这里 */
  openLink(uri: string): void
  /** 输出里少了一段，终端里要写的那一行说明 */
  gapText(mark: TerminalMark): string
  /** 正开着全屏程序的时候少了一段：不能往它的画面里写字，换个地方说 */
  gapNotice(mark: TerminalMark): void
}

type Item =
  | { kind: 'data'; bytes: Uint8Array; ackTo: number | null }
  | { kind: 'mark'; mark: TerminalMark }
  | { kind: 'reset'; epoch: number }

const ESC = 0x1b
const LF = 0x0a
/** 找不到边界的时候最多丢这么多字节，之后照常显示 */
const SKIP_MAX = 8192
const RESIZE_DELAY_MS = 60
const REDRAW_DELAY_MS = 250

export class TerminalSession {
  readonly host: HTMLDivElement
  readonly term: Terminal
  readonly #owner: SessionHost
  readonly #fit = new FitAddon()
  #opened = false
  #disposed = false
  #state: TerminalState = 'running'
  #stop: (() => void) | null = null
  #viewer = 0
  #epoch = 0
  #queue: Item[] = []
  /** 在等前面的字画完：记号和重开要到那时才办 */
  #waiting = false
  /** 接下来的字可能从一个转义序列的中间开始：丢到下一个换行或转义为止 */
  #skip = 0
  #resizeTimer = 0
  #redrawTimer = 0
  /** 上一次告诉对面的行列数 */
  #told: { rows: number; cols: number }

  constructor(owner: SessionHost) {
    this.#owner = owner
    this.#told = { rows: owner.rows, cols: owner.cols }
    this.host = document.createElement('div')
    this.host.className = 'term-host'
    this.host.dataset.terminal = owner.terminalId
    this.term = new Terminal({
      rows: owner.rows,
      cols: owner.cols,
      allowProposedApi: true,
      fontFamily: owner.look.fontFamily,
      fontSize: owner.look.fontSize,
      lineHeight: owner.look.lineHeight,
      theme: owner.look.theme,
      scrollback: 5000,
      cursorBlink: false,
      cursorInactiveStyle: 'outline',
      drawBoldTextInBrightColors: false,
      // 程序选的颜色在这套皮肤的底色上看不清时，往看得清的方向挪一点
      minimumContrastRatio: 4.5,
    })
    // 东亚文字和表情按两格算，和对面 shell 的算法对上
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.term.loadAddon(this.#fit)
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (/^https?:\/\//i.test(uri)) owner.openLink(uri)
      }),
    )
    this.term.onData((data) => this.#send(encodeBase64(encodeUtf8(data))))
    // 鼠标上报用的老编码：一个字符一个字节
    this.term.onBinary((data) =>
      this.#send(encodeBase64(Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff))),
    )
    this.term.onResize(({ rows, cols }) => this.#wantSize(rows, cols))
    this.term.attachCustomKeyEventHandler((event) => this.#key(event))
    this.#stop = owner.channel.subscribe(
      { kind: 'terminal', deviceId: owner.deviceId, terminalId: owner.terminalId },
      {
        snapshot: (view) => this.#snapshot(view),
        delta: (ops) => this.#delta(ops),
        // 订阅出错多半是这个终端已经没了：标签会跟着列表消失，这里不用再说
        error() {},
      },
    )
  }

  /** 第一次显示出来的时候才真的画：那时才量得到一个字多宽 */
  open(): void {
    if (this.#opened || this.#disposed) return
    this.#opened = true
    this.term.open(this.host)
  }

  get opened(): boolean {
    return this.#opened
  }

  setState(state: TerminalState): void {
    this.#state = state
    // 没在跑的时候敲键不该有反应
    this.term.options.disableStdin = state !== 'running'
  }

  /** 换配色。颜色和字体分开换：颜色马上就能换，字体要等字体文件到了（见 sessions.ts 的 restyle） */
  setTheme(theme: Look['theme']): void {
    this.term.options.theme = theme
  }

  setFont(look: Look): void {
    this.term.options.fontFamily = look.fontFamily
    this.term.options.fontSize = look.fontSize
    this.term.options.lineHeight = look.lineHeight
  }

  /** 按容器现在的大小算行列数。变了的话终端控件会报，随后告诉对面 */
  fit(): void {
    if (!this.#opened || !this.host.isConnected || this.host.clientHeight < 8) return
    const size = this.#fit.proposeDimensions()
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return
    if (size.cols !== this.term.cols || size.rows !== this.term.rows) {
      this.term.resize(Math.max(size.cols, 2), Math.max(size.rows, 1))
    }
  }

  /** 对面的伪终端现在是这个大小（可能是别处改的）：和这边不一样就改回这边的 */
  syncSize(rows: number, cols: number): void {
    if (!this.#opened) return
    if (rows === this.term.rows && cols === this.term.cols) {
      this.#told = { rows, cols }
      return
    }
    this.#told = { rows, cols }
    this.#wantSize(this.term.rows, this.term.cols)
  }

  focus(): void {
    this.term.focus()
  }

  /** 清屏：只清这一头显示的，对面的程序不知道 */
  clear(): void {
    this.term.clear()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    window.clearTimeout(this.#resizeTimer)
    window.clearTimeout(this.#redrawTimer)
    this.#stop?.()
    this.#stop = null
    this.term.dispose()
    this.host.remove()
  }

  // ---------- 输出 ----------

  #snapshot(view: TerminalStreamView): void {
    this.#viewer = view.viewer
    this.#epoch = view.epoch
    if (view.truncated || view.missed > 0) {
      // 不是从头开始的：开头可能是半个转义序列，而且正开着的全屏程序要让它重画一遍
      this.#skip = SKIP_MAX
      this.#redrawSoon()
    }
  }

  #delta(ops: TerminalOp[]): void {
    for (const op of ops) {
      if (op.op === 'output') {
        const last = op.chunks.length - 1
        op.chunks.forEach((chunk, index) => {
          this.#queue.push({
            kind: 'data',
            bytes: decodeBase64(chunk),
            ackTo: index === last ? op.to : null,
          })
        })
        if (last < 0) this.#ack(op.to)
      } else if (op.op === 'mark') this.#queue.push({ kind: 'mark', mark: op.mark })
      else this.#queue.push({ kind: 'reset', epoch: op.epoch })
    }
    this.#pump()
  }

  #pump(): void {
    while (!this.#waiting) {
      const item = this.#queue.shift()
      if (!item) return
      if (item.kind === 'data') {
        const bytes = this.#skip > 0 ? this.#afterBoundary(item.bytes) : item.bytes
        const ackTo = item.ackTo
        // 终端控件解析完这一批才回报：核心据此决定给不给下一批
        if (ackTo === null) this.term.write(bytes)
        else this.term.write(bytes, () => this.#ack(ackTo))
        continue
      }
      // 记号和重开要等前面的字都画进去了再办：那时才知道现在是哪一种屏幕
      this.#waiting = true
      this.term.write('', () => {
        this.#waiting = false
        if (item.kind === 'mark') this.#mark(item.mark)
        else this.#reset(item.epoch)
        this.#pump()
      })
    }
  }

  /** 丢掉开头到第一个换行或转义之前的那一截。整块里都没有边界就整块丢，丢够了数就不再丢 */
  #afterBoundary(bytes: Uint8Array): Uint8Array {
    for (let at = 0; at < bytes.length; at++) {
      if (bytes[at] === ESC || bytes[at] === LF) {
        this.#skip = 0
        return bytes.subarray(at)
      }
    }
    this.#skip = Math.max(0, this.#skip - bytes.length)
    return bytes.subarray(bytes.length)
  }

  #mark(mark: TerminalMark): void {
    // 断线之后一个字节不少地补回来了：不用说什么
    if (mark.missed <= 0) return
    this.#skip = SKIP_MAX
    // 说过几次“少了一段”。说明本身会跟着后面的输出滚走，自检从这里数
    this.host.dataset.gaps = String(Number(this.host.dataset.gaps ?? 0) + 1)
    if (this.term.buffer.active.type === 'alternate') {
      // 全屏程序的画面里不能插字：换个地方说，并让它重画
      this.#owner.gapNotice(mark)
      this.#redrawSoon()
      return
    }
    // 先把可能停在半截的转义序列掐断、颜色还原，再另起一行写说明
    this.term.write(`\u0018\u001b[0m\r\n\u001b[2m··· ${this.#owner.gapText(mark)} ···\u001b[0m\r\n`)
  }

  #reset(epoch: number): void {
    this.#epoch = epoch
    this.#skip = 0
    this.term.reset()
  }

  #ack(offset: number): void {
    const { channel, deviceId, terminalId } = this.#owner
    channel
      .command('terminal.ack', {
        deviceId,
        terminalId,
        viewer: this.#viewer,
        epoch: this.#epoch,
        offset,
      })
      .catch(() => {})
  }

  /** 过一小会儿让对面的程序重画（连着来的几次并成一次） */
  #redrawSoon(): void {
    window.clearTimeout(this.#redrawTimer)
    this.#redrawTimer = window.setTimeout(() => {
      const { channel, deviceId, terminalId } = this.#owner
      channel.command('terminal.redraw', { deviceId, terminalId }).catch(() => {})
    }, REDRAW_DELAY_MS)
  }

  // ---------- 输入 ----------

  #send(data: string): void {
    if (this.#state !== 'running') return
    const { channel, deviceId, terminalId } = this.#owner
    // 写不进去（刚好断线、刚好退出）不用单独说：状态条会跟着变
    channel.command('terminal.write', { deviceId, terminalId, data }).catch(() => {})
  }

  #wantSize(rows: number, cols: number): void {
    window.clearTimeout(this.#resizeTimer)
    this.#resizeTimer = window.setTimeout(() => {
      if (rows === this.#told.rows && cols === this.#told.cols) return
      this.#told = { rows, cols }
      const { channel, deviceId, terminalId } = this.#owner
      channel.command('terminal.resize', { deviceId, terminalId, rows, cols }).catch(() => {})
    }, RESIZE_DELAY_MS)
  }

  /** 返回 false 表示这个键终端控件不要管 */
  #key(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true
    const key = event.key.toLowerCase()
    if (this.#owner.mac) {
      // macOS 上复制粘贴是 Cmd+C、Cmd+V，系统自己处理，和中断键不冲突。这里只加一个清屏
      if (event.metaKey && !event.ctrlKey && !event.altKey && key === 'k') {
        event.preventDefault()
        this.term.clear()
        return false
      }
      return true
    }
    if (!event.ctrlKey || event.altKey || event.metaKey) return true
    // 有选区的时候 Ctrl+C 是复制；没有选区就是中断键，照常交给程序
    if (key === 'c' && (event.shiftKey || this.term.hasSelection())) {
      event.preventDefault()
      this.#copy()
      return false
    }
    // 粘贴让浏览器照常办：粘贴事件终端控件自己会接
    if (key === 'v') return false
    return true
  }

  #copy(): void {
    const text = this.term.getSelection()
    if (!text) return
    const done = () => this.term.clearSelection()
    const viaCommand = () => {
      // 复制事件终端控件自己会接，把选中的字放进去
      document.execCommand('copy')
      done()
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, viaCommand)
    else viaCommand()
  }
}
