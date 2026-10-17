// 一个终端的画面：WebView 里的 xterm（src/web/terminal-page.js）加上它和核心之间的那座桥。
// 订阅输出（terminal 主题）、回报处理到哪（terminal.ack）、把敲的键写进去（terminal.write）都在这里；
// 字节以 base64 原样过桥，这一头不解码也不编码：大量输出时 JS 线程只是转手字符串。
// 流控照桌面端：页面里的 xterm 画完一批才回报，核心在回报之前只给有限的量，所以输出再快，压在页面里的也有上限，
// 落后太多的部分核心只留末尾，略过的地方页面写一行说明。
//
// 页面只建一次：换终端时清屏、换一份订阅（核心补给它还留着的那一段），不重建 WebView。

import type { TerminalOp } from '@litch/core'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { Linking, StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { showKeyboard } from '../../../../modules/litch-keyboard/src'
import { useChannel } from '../../../shell/services'
import { TERMINAL_HTML } from '../../../web/terminal-html.generated'
import { TERM_FONT_SIZE, type TermTheme } from './look'

/** 页面发出来的消息（见 terminal-page.js 开头的约定） */
type PageMessage =
  | { t: 'ready'; rows: number; cols: number }
  | { t: 'size'; rows: number; cols: number }
  | { t: 'in'; b: string }
  | { t: 'ack'; g: number; e: number; o: number }
  | { t: 'redraw' }
  | { t: 'ctrl'; on: boolean }
  | { t: 'kb'; on: boolean }
  | { t: 'link'; uri: string }
  | { t: 'error'; message: string }
  | { t: 'frames'; count: number; p95: number; max: number; bytes: number }

/** 输入条要往页面里送的几样 */
export type TerminalInput =
  | { t: 'key'; k: string }
  | { t: 'text'; d: string }
  | { t: 'ctrl'; on: boolean }
  | { t: 'focus' }
  | { t: 'blur' }
  | { t: 'clear' }

export interface TerminalHandle {
  send(input: TerminalInput): void
}

export interface TerminalViewProps {
  deviceId: string
  /** 现在看的是哪个终端。null：还没有（正在开、开不成） */
  terminalId: string | null
  /** 在运行：不在运行的时候敲键没反应 */
  running: boolean
  theme: TermTheme
  /** 两句说明：输出略过了一段、断线期间少了一段（{size} 由页面填） */
  gapText: string
  rejoinedText: string
  /** 页面量出来的行列数（建好时一次，之后每次变了一次） */
  onSize(rows: number, cols: number): void
  /** Ctrl 用掉了 */
  onCtrlUsed(): void
  /** 键盘焦点进出终端 */
  onKeyboard(on: boolean): void
  /** 测量用：每秒往日志里写一行帧数和 JS 线程的延迟（scripts 里按 LITCH_TERM 收） */
  stats?: boolean
}

const script = (message: unknown): string => `window.__litch(${JSON.stringify(message)});true;`

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    const { deviceId, terminalId, running, theme, stats } = props
    const channel = useChannel()
    const view = useRef<WebView>(null)
    const ready = useRef(false)
    /** 第几份订阅：页面的回报带着它，过时的回报丢掉 */
    const gen = useRef(0)
    const live = useRef<{ g: number; viewer: number; terminalId: string } | null>(null)
    const latest = useRef(props)
    latest.current = props
    /** 页面还没好时要送的，好了一起送 */
    const pending = useRef<string[]>([])
    /** 按了 ⌨、还等着页面里的输入框拿到焦点：拿到了再请系统输入法弹键盘 */
    const wantKeyboard = useRef(false)

    const post = useCallback((message: unknown) => {
      const code = script(message)
      if (ready.current) view.current?.injectJavaScript(code)
      else pending.current.push(code)
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        send(input: TerminalInput) {
          // WebView 在原生层没拿过焦点时，页面里 focus() 弹不出系统键盘：先让它拿焦点
          if (input.t === 'focus') {
            view.current?.requestFocus()
            wantKeyboard.current = true
          } else if (input.t === 'blur') wantKeyboard.current = false
          post(input)
        },
      }),
      [post],
    )

    // 启动参数在页面脚本跑之前就放好：配色、字号、两句说明、要不要统计
    const config = useMemo(
      () =>
        `window.__litchConfig=${JSON.stringify({
          theme: latest.current.theme,
          fontSize: TERM_FONT_SIZE,
          text: { gap: latest.current.gapText, rejoined: latest.current.rejoinedText },
          stats: !!latest.current.stats,
        })};true;`,
      [],
    )

    // 换终端：清屏，换一份订阅
    useEffect(() => {
      if (!terminalId) return
      const g = ++gen.current
      live.current = null
      post({ t: 'start', g, epoch: 0, truncated: false })
      const stop = channel.subscribe(
        { kind: 'terminal', deviceId, terminalId },
        {
          snapshot(stream) {
            live.current = { g, viewer: stream.viewer, terminalId }
            post({
              t: 'start',
              g,
              epoch: stream.epoch,
              truncated: stream.truncated || stream.missed > 0,
            })
          },
          delta(ops: TerminalOp[]) {
            post({ t: 'ops', g, ops })
          },
          // 订阅出错多半是这个终端已经没了：列表会跟着变，状态条会说
          error() {},
        },
      )
      return () => {
        stop()
        live.current = null
      }
    }, [channel, deviceId, terminalId, post])

    useEffect(() => post({ t: 'state', running }), [post, running])
    useEffect(() => post({ t: 'theme', theme }), [post, theme])

    // 测量：JS 线程每 16ms 打一次点，记这一秒里最长晚了多久
    const lag = useRef(0)
    useEffect(() => {
      if (!stats) return
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        lag.current = Math.max(lag.current, now - last - 16)
        last = now
      }, 16)
      return () => clearInterval(timer)
    }, [stats])

    const onMessage = (event: WebViewMessageEvent) => {
      let message: PageMessage
      try {
        message = JSON.parse(event.nativeEvent.data) as PageMessage
      } catch {
        return
      }
      const now = latest.current
      switch (message.t) {
        case 'ready': {
          ready.current = true
          const queued = pending.current
          pending.current = []
          for (const code of queued) view.current?.injectJavaScript(code)
          now.onSize(message.rows, message.cols)
          break
        }
        case 'size':
          now.onSize(message.rows, message.cols)
          break
        case 'in': {
          const id = now.terminalId
          // 写不进去（刚好断线、刚好退出）不用单独说：状态条会跟着变
          if (id)
            channel
              .command('terminal.write', { deviceId, terminalId: id, data: message.b })
              .catch(() => {})
          break
        }
        case 'ack': {
          const current = live.current
          if (!current || current.g !== message.g) break
          channel
            .command('terminal.ack', {
              deviceId,
              terminalId: current.terminalId,
              viewer: current.viewer,
              epoch: message.e,
              offset: message.o,
            })
            .catch(() => {})
          break
        }
        case 'redraw': {
          const id = now.terminalId
          if (id) channel.command('terminal.redraw', { deviceId, terminalId: id }).catch(() => {})
          break
        }
        case 'ctrl':
          now.onCtrlUsed()
          break
        case 'kb':
          // 页面里 focus() 在没有手势时弹不出软键盘：输入框真拿到焦点了，由原生那头弹
          // （页面会先让开焦点再拿回来，让开那一下的回报不算）
          if (message.on && wantKeyboard.current) {
            wantKeyboard.current = false
            showKeyboard()
          }
          now.onKeyboard(message.on)
          break
        case 'link':
          if (/^https?:\/\//i.test(message.uri)) Linking.openURL(message.uri).catch(() => {})
          break
        case 'error':
          console.warn(`LITCH_TERM_ERROR ${message.message}`)
          break
        case 'frames':
          console.log(
            `LITCH_TERM ${JSON.stringify({ ...message, t: undefined, jsLag: Math.round(lag.current) })}`,
          )
          lag.current = 0
          break
      }
    }

    return (
      <WebView
        ref={view}
        source={{ html: TERMINAL_HTML }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={config}
        onMessage={onMessage}
        javaScriptEnabled
        // 系统字号放大不能改终端里字的大小：列数是按量出来的字宽算的
        textZoom={100}
        overScrollMode="never"
        setBuiltInZoomControls={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        style={[styles.web, { backgroundColor: theme.background }]}
        testID="terminal:web"
      />
    )
  },
)

const styles = StyleSheet.create({
  web: { flex: 1 },
})
