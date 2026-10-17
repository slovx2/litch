// WebView 里的终端页（scripts/build-webview-bench.mjs 把它和 xterm 拼成一页）。
// 终端的建法照桌面端（packages/ui/src/terminal/session.ts）：同一版 xterm、同样的选项和两个插件，DOM 渲染。
// 和外面（RN）的约定，一条消息一段 JSON（进来的经 window.__litchReceive，出去的经 ReactNativeWebView.postMessage）：
//   进来 {t:'data', d:'文字'}      写进终端；写完（xterm 的回调）回 {t:'ack', n:字数}
//   进来 {t:'ping', id, at}        原样回 {t:'pong', id, at}，量来回一趟多久
//   进来 {t:'reset'}               清屏，帧统计从头算
//   出去 {t:'frames', ...}         每秒一条：这一秒画了几帧、帧间隔的高位和最长、超过 50ms 的有几帧
//   出去 {t:'ready', cols, rows}   终端建好了
;(() => {
  const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorBlink: false,
    cursorInactiveStyle: 'outline',
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 4.5,
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(new Unicode11Addon.Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(fit)
  term.open(document.getElementById('term'))
  fit.fit()
  window.addEventListener('resize', () => fit.fit())

  // 帧统计：rAF 的间隔就是这一页实际出帧的节奏
  let gaps = []
  let last = performance.now()
  const tick = (now) => {
    gaps.push(now - last)
    last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  setInterval(() => {
    const sorted = gaps.toSorted((a, b) => a - b)
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
    post({
      t: 'frames',
      count: sorted.length,
      p50: Math.round(at(0.5) * 10) / 10,
      p95: Math.round(at(0.95) * 10) / 10,
      max: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
      over50: sorted.filter((gap) => gap > 50).length,
    })
    gaps = []
  }, 1000)

  const receive = (raw) => {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.t === 'data') term.write(message.d, () => post({ t: 'ack', n: message.d.length }))
    else if (message.t === 'ping') post({ t: 'pong', id: message.id, at: message.at })
    else if (message.t === 'reset') {
      term.reset()
      gaps = []
    }
  }
  // 外面经 injectJavaScript 调这个（每条消息是一小段要页面解析执行的脚本，也算进要量的开销）
  window.__litchReceive = receive
  post({ t: 'ready', cols: term.cols, rows: term.rows })
})()
