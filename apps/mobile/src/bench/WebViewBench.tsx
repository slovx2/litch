// WebView 吞吐测试：把桌面端用的终端（同一版 xterm、同样的建法，见 terminal-page.js）放进 WebView，
// 经 injectJavaScript 喂数据、经 postMessage 收确认，看三件事（结果写进日志 LITCH_WEBVIEW，scripts/bench.mjs 的 webview 场景收）：
//   latency  小消息来回一趟多久（RN → 页面 → RN）
//   steady   匀速喂日志（约 200 KB/s，像构建、测试在刷屏），页面每秒出几帧、卡不卡
//   flood    能喂多快就喂多快，按页面的确认收着（在途不超过 256 KB，桌面端终端也是按确认限量），量吞吐
// 生成的页面在 terminal-html.generated.ts（scripts/build-webview-bench.mjs）。
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { TERMINAL_HTML, XTERM_VERSION } from './terminal-html.generated'

type PageMessage =
  | { t: 'ready'; cols: number; rows: number }
  | { t: 'ack'; n: number }
  | { t: 'pong'; id: number; at: number }
  | { t: 'frames'; count: number; p50: number; p95: number; max: number; over50: number }

const STEADY_RATE = 200 * 1024
const FLOOD_WINDOW = 256 * 1024
const FLOOD_CHUNK = 32 * 1024
const PHASE_MS = 10_000

/** 一行像样的日志：时间、级别（带颜色）、来源、一句话，约一百个字 */
function logLine(n: number): string {
  const level = n % 17 === 0 ? '\x1b[31mERROR\x1b[0m' : n % 5 === 0 ? '\x1b[33mWARN \x1b[0m' : '\x1b[32mINFO \x1b[0m'
  const ms = String(n % 1000).padStart(3, '0')
  return `[12:00:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}.${ms}] ${level} worker-${n % 8} processed item ${n} in ${(n % 97) / 10}ms 中文也有一点\r\n`
}

function text(bytes: number, from: number): { text: string; next: number } {
  let out = ''
  let n = from
  while (out.length < bytes) out += logLine(n++)
  return { text: out, next: n }
}

const percentile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) * 10) / 10
}

export function WebViewBench({ onBack }: { onBack(): void }) {
  const view = useRef<WebView>(null)
  const listeners = useRef(new Set<(message: PageMessage) => void>())
  const [lines, setLines] = useState<string[]>([`xterm ${XTERM_VERSION}，等页面…`])
  const say = (line: string) => setLines((current) => [...current, line])

  const onMessage = (event: WebViewMessageEvent) => {
    const message = JSON.parse(event.nativeEvent.data) as PageMessage
    for (const listener of listeners.current) listener(message)
  }

  useEffect(() => {
    let stopped = false
    // 进页面走 injectJavaScript：每条是一段要页面解析执行的脚本，这也是要量的开销的一部分
    const send = (message: unknown) =>
      view.current?.injectJavaScript(`window.__litchReceive(${JSON.stringify(JSON.stringify(message))});true;`)
    const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
    const listen = (listener: (message: PageMessage) => void) => {
      listeners.current.add(listener)
      return () => listeners.current.delete(listener)
    }
    const report = (phase: string, result: Record<string, unknown>) => {
      console.log(`LITCH_WEBVIEW ${JSON.stringify({ phase, ...result })}`)
      say(`${phase}：${JSON.stringify(result)}`)
    }
    /** 这一段时间里页面报的每秒帧统计 */
    const frames = () => {
      const seconds: Extract<PageMessage, { t: 'frames' }>[] = []
      const stop = listen((message) => {
        if (message.t === 'frames') seconds.push(message)
      })
      return () => {
        stop()
        const used = seconds.slice(1)
        return {
          fpsMin: Math.min(...used.map((s) => s.count)),
          fpsMedian: percentile(
            used.map((s) => s.count),
            0.5,
          ),
          gapP95Max: Math.max(...used.map((s) => s.p95)),
          gapMax: Math.max(...used.map((s) => s.max)),
          over50: used.reduce((sum, s) => sum + s.over50, 0),
        }
      }
    }

    const run = async () => {
      await new Promise<void>((done) => {
        const stop = listen((message) => {
          if (message.t !== 'ready') return
          stop()
          say(`页面好了：${message.cols}×${message.rows}`)
          done()
        })
      })
      await wait(1500)

      // 来回一趟
      const trips: number[] = []
      const stopPong = listen((message) => {
        if (message.t === 'pong') trips.push(performance.now() - message.at)
      })
      for (let id = 0; id < 50 && !stopped; id += 1) {
        send({ t: 'ping', id, at: performance.now() })
        await wait(100)
      }
      stopPong()
      report('latency', { count: trips.length, p50: percentile(trips, 0.5), p95: percentile(trips, 0.95), max: percentile(trips, 1) })

      // 匀速
      send({ t: 'reset' })
      await wait(500)
      let line = 0
      let acked = 0
      const stopAck = listen((message) => {
        if (message.t === 'ack') acked += message.n
      })
      let steadyFrames = frames()
      const steadyStart = performance.now()
      let sent = 0
      while (performance.now() - steadyStart < PHASE_MS && !stopped) {
        const piece = text(STEADY_RATE / 20, line)
        line = piece.next
        send({ t: 'data', d: piece.text })
        sent += piece.text.length
        await wait(50)
      }
      await wait(1000)
      report('steady', { sentKB: Math.round(sent / 1024), ackedKB: Math.round(acked / 1024), ...steadyFrames() })

      // 能多快就多快
      send({ t: 'reset' })
      await wait(500)
      acked = 0
      sent = 0
      steadyFrames = frames()
      const floodStart = performance.now()
      while (performance.now() - floodStart < PHASE_MS && !stopped) {
        if (sent - acked >= FLOOD_WINDOW) {
          await wait(4)
          continue
        }
        const piece = text(FLOOD_CHUNK, line)
        line = piece.next
        send({ t: 'data', d: piece.text })
        sent += piece.text.length
        await wait(0)
      }
      const floodMs = performance.now() - floodStart
      stopAck()
      report('flood', {
        ackedKB: Math.round(acked / 1024),
        kbPerSecond: Math.round(acked / 1024 / (floodMs / 1000)),
        ...steadyFrames(),
      })
      say('完了')
    }
    run().catch((error: Error) => console.log(`LITCH_WEBVIEW_ERROR ${error.message}`))
    return () => {
      stopped = true
    }
  }, [])

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.back}>返回</Text>
        </Pressable>
        <Text style={styles.title}>WebView 吞吐</Text>
      </View>
      <View style={styles.term}>
        <WebView
          ref={view}
          source={{ html: TERMINAL_HTML }}
          originWhitelist={['*']}
          onMessage={onMessage}
          javaScriptEnabled
        />
      </View>
      <View style={styles.log}>
        {lines.slice(-6).map((line, index) => (
          <Text key={`${index}:${line}`} style={styles.logLine} numberOfLines={2}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  header: { height: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 16 },
  back: { color: '#0a66c2', fontSize: 15 },
  title: { fontSize: 16, fontWeight: '600' },
  term: { flex: 1 },
  log: { padding: 8, gap: 2 },
  logLine: { fontSize: 11, color: '#333' },
})
