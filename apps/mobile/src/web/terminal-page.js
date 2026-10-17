// 终端页：WebView 里的 xterm（scripts/build-webview-terminal.mjs 把它和 xterm、插件、样式拼成一页，内嵌成字符串）。
// 终端的建法照桌面端（packages/ui/src/terminal/session.ts）：同一版 xterm、同样的选项和插件，DOM 渲染；
// 输出的排队、半截转义序列的跳过、记号的说法也照它，只是核心不在这一页里：订阅、命令都在 RN 那头（TerminalView.tsx），
// 这一页只管画和收键。字节一律以 base64 过桥，RN 那头不解码、不编码，只转手。
//
// 和 RN 的约定。进来的经 window.__litch(消息)（RN 用 injectJavaScript 调），出去的经 ReactNativeWebView.postMessage(JSON)：
//   进 {t:'start', g, epoch, truncated}   开始接一份新的输出（换了终端、重新订阅）：清屏，之后的确认带上 g
//   进 {t:'ops', g, ops}                  核心的 TerminalOp 原样转来：output（base64 的几块）、mark、reset
//   进 {t:'state', running}               不在运行的时候敲键没反应
//   进 {t:'key', k}                       输入条上的键（esc、tab、up、down、left、right、home、end、pgup、pgdn）
//   进 {t:'text', d}                      输入条上的符号，和键盘打的字一样经过 Ctrl
//   进 {t:'ctrl', on}                     输入条上的 Ctrl 按下、松开：按下之后下一个字（或方向键）带上 Ctrl
//   进 {t:'focus'} / {t:'blur'}           弹出、收起键盘
//   进 {t:'theme', theme}                 换配色
//   进 {t:'clear'}                        清屏（只清这一头显示的）
//   出 {t:'ready', rows, cols}            建好了，量出来的行列数
//   出 {t:'size', rows, cols}             行列数变了（转屏、键盘弹起收起）
//   出 {t:'in', b}                        要写进终端的字节（base64）
//   出 {t:'ack', g, e, o}                 第 g 份输出、代号 e 的这一段已经画到偏移 o
//   出 {t:'redraw'}                       补回来的输出不完整，请里面的全屏程序重画
//   出 {t:'ctrl', on:false}               Ctrl 用掉了
//   出 {t:'kb', on}                       键盘焦点在不在终端上（输入条上键盘键的样子）
//   出 {t:'link', uri}                    点了输出里的 http(s) 链接
//   出 {t:'error', message}               页面里出的错
//   出 {t:'frames', ...}                  开了统计时每秒一条（帧数、帧间隔、这一秒画了多少字节）
// 启动参数在 window.__litchConfig（RN 用 injectedJavaScriptBeforeContentLoaded 先放好）：theme、fontSize、text（两句说明）、stats。
;(() => {
  const config = window.__litchConfig || {}
  const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
  // 页面里出的错交给 RN 记日志（release 包里看不到页面的控制台）
  window.addEventListener('error', (event) => post({ t: 'error', message: String(event.message) }))
  const ESC = 0x1b
  const LF = 0x0a
  /** 找不到边界的时候最多丢这么多字节，之后照常显示 */
  const SKIP_MAX = 8192
  const FIT_DELAY_MS = 80
  const REDRAW_DELAY_MS = 250

  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: 'monospace',
    fontSize: config.fontSize || 12,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorBlink: false,
    cursorInactiveStyle: 'outline',
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 4.5,
    theme: config.theme,
  })
  const fit = new FitAddon.FitAddon()
  // 东亚文字和表情按两格算，和对面 shell 的算法对上
  term.loadAddon(new Unicode11Addon.Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(fit)
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri)) post({ t: 'link', uri })
    }),
  )
  const host = document.getElementById('term')
  if (config.theme?.background) document.body.style.background = config.theme.background
  term.open(host)
  fit.fit()

  // ---------- 字节与 base64 ----------

  const fromBase64 = (text) => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
    return bytes
  }
  const toBase64 = (bytes) => {
    let binary = ''
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000))
    }
    return btoa(binary)
  }
  const utf8 = new TextEncoder()

  /** 1.2 KB、3.4 MB */
  const sizeText = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  const say = (template, mark) => String(template || '').replace('{size}', sizeText(mark.missed))

  // ---------- 输出 ----------
  // 每次 start 换一份新的流：之前那份还没画完的回调认出自己过时了，什么都不做

  let stream = null
  let redrawTimer = 0
  let written = 0

  const redrawSoon = () => {
    clearTimeout(redrawTimer)
    redrawTimer = setTimeout(() => post({ t: 'redraw' }), REDRAW_DELAY_MS)
  }

  const start = (message) => {
    clearTimeout(settleTimer)
    // catching：还在补订阅之前的那一段输出，见下面 settleSoon
    stream = {
      g: message.g,
      epoch: message.epoch,
      queue: [],
      waiting: false,
      skip: 0,
      catching: true,
    }
    term.reset()
    if (message.truncated) {
      // 不是从头开始的：开头可能是半个转义序列，而且正开着的全屏程序要让它重画一遍
      stream.skip = SKIP_MAX
      redrawSoon()
    }
    // 一个字都还没来的话，歇一会儿也算追上了
    settleSoon(stream)
  }

  /** 丢掉开头到第一个换行或转义之前的那一截。整块里都没有边界就整块丢，丢够了数就不再丢 */
  const afterBoundary = (s, bytes) => {
    for (let at = 0; at < bytes.length; at++) {
      if (bytes[at] === ESC || bytes[at] === LF) {
        s.skip = 0
        return bytes.subarray(at)
      }
    }
    s.skip = Math.max(0, s.skip - bytes.length)
    return bytes.subarray(bytes.length)
  }

  const ack = (s, offset) => post({ t: 'ack', g: s.g, e: s.epoch, o: offset })

  // 补回来的旧输出里有程序当时发的询问（vim、top 启动时问终端的型号、颜色），xterm 画到那里会照样作答，
  // 答复就成了打进 shell 的一串乱码。所以补的那一段画完之前不交出程序该收的答复；
  // 画完、歇了一小会儿没有新的输出，就算追上了，之后的询问照常作答
  const SETTLE_MS = 300
  let settleTimer = 0
  const settleSoon = (s) => {
    clearTimeout(settleTimer)
    if (!s.catching || s.queue.length > 0) return
    settleTimer = setTimeout(() => {
      if (stream === s && s.queue.length === 0) s.catching = false
    }, SETTLE_MS)
  }

  const mark = (s, value) => {
    // 断线之后一个字节不少地补回来了：不用说什么
    if (value.missed <= 0) return
    s.skip = SKIP_MAX
    if (term.buffer.active.type === 'alternate') {
      // 全屏程序的画面里不能插字：让它重画
      redrawSoon()
      return
    }
    const text = value.kind === 'rejoined' ? config.text?.rejoined : config.text?.gap
    // 先把可能停在半截的转义序列掐断、颜色还原，再另起一行写说明
    term.write(`\u0018\u001b[0m\r\n\u001b[2m··· ${say(text, value)} ···\u001b[0m\r\n`)
  }

  const pump = (s) => {
    while (!s.waiting && stream === s) {
      const item = s.queue.shift()
      if (!item) return
      if (item.kind === 'data') {
        const bytes = s.skip > 0 ? afterBoundary(s, item.bytes) : item.bytes
        written += bytes.length
        const ackTo = item.ackTo
        // 终端控件解析完这一批才回报：核心据此决定给不给下一批
        if (ackTo === null) term.write(bytes)
        else
          term.write(bytes, () => {
            ack(s, ackTo)
            settleSoon(s)
          })
        continue
      }
      // 记号和重开要等前面的字都画进去了再办：那时才知道现在是哪一种屏幕
      s.waiting = true
      term.write('', () => {
        if (stream !== s) return
        s.waiting = false
        if (item.kind === 'mark') mark(s, item.mark)
        else {
          s.epoch = item.epoch
          s.skip = 0
          term.reset()
        }
        pump(s)
      })
    }
  }

  const ops = (message) => {
    const s = stream
    if (!s || s.g !== message.g) return
    clearTimeout(settleTimer)
    for (const op of message.ops) {
      if (op.op === 'output') {
        const last = op.chunks.length - 1
        op.chunks.forEach((chunk, index) => {
          s.queue.push({
            kind: 'data',
            bytes: fromBase64(chunk),
            ackTo: index === last ? op.to : null,
          })
        })
        if (last < 0) ack(s, op.to)
      } else if (op.op === 'mark') s.queue.push({ kind: 'mark', mark: op.mark })
      else s.queue.push({ kind: 'reset', epoch: op.epoch })
    }
    pump(s)
  }

  // ---------- 输入 ----------

  let running = false
  let ctrl = false

  const send = (bytes) => {
    if (!running || bytes.length === 0) return
    post({ t: 'in', b: toBase64(bytes) })
  }

  const CTRL_PUNCT = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, _: 31, '?': 127 }

  /** 带上 Ctrl 之后的样子：字母和几个符号变成控制字符，方向键这类变成带修饰的序列；别的原样 */
  const withCtrl = (data) => {
    if (data.length === 1) {
      const code = data.charCodeAt(0)
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        return String.fromCharCode(code & 0x1f)
      }
      if (data in CTRL_PUNCT) return String.fromCharCode(CTRL_PUNCT[data])
      return data
    }
    // ESC [ A、ESC O A 这类（方向键、Home、End）：换成 ESC [ 1 ; 5 A
    const arrow = /^\u001b[[O]([A-DHF])$/.exec(data)
    if (arrow) return `\u001b[1;5${arrow[1]}`
    return data
  }

  const typed = (data) => {
    if (ctrl) {
      data = withCtrl(data)
      ctrl = false
      post({ t: 'ctrl', on: false })
    }
    send(utf8.encode(data))
  }

  term.onData((data) => {
    // 还在补旧输出时，以 ESC 打头的是 xterm 替程序作答的（人在屏幕键盘上打不出 ESC，输入条上的键不走这里）
    if (stream?.catching && data.charCodeAt(0) === ESC) return
    typed(data)
  })
  // 鼠标上报用的老编码：一个字符一个字节
  term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff)))

  /** 输入条上的键。方向键、Home、End 跟着程序要的模式走（vim、less 打开了“应用光标键”就是 ESC O） */
  const keyText = (name) => {
    const app = term.modes.applicationCursorKeysMode
    const cursor = (final) => (app ? `\u001bO${final}` : `\u001b[${final}`)
    switch (name) {
      case 'esc':
        return '\u001b'
      case 'tab':
        return '\t'
      case 'up':
        return cursor('A')
      case 'down':
        return cursor('B')
      case 'right':
        return cursor('C')
      case 'left':
        return cursor('D')
      case 'home':
        return cursor('H')
      case 'end':
        return cursor('F')
      case 'pgup':
        return '\u001b[5~'
      case 'pgdn':
        return '\u001b[6~'
      default:
        return ''
    }
  }

  // 键盘焦点在不在终端上：输入条上那个键盘键据此画成按下或没按下
  const textarea = host.querySelector('textarea')
  textarea?.addEventListener('focus', () => post({ t: 'kb', on: true }))
  textarea?.addEventListener('blur', () => post({ t: 'kb', on: false }))

  // ---------- 手指滚动 ----------
  // 这一版 xterm 在手机上划不动回滚区，这里自己接：手指上下划，平常的屏幕滚回滚区，
  // 全屏程序（vim、less、top，用的是另一块屏幕）里换成上下方向键，像桌面终端滚滚轮那样。
  // 移动不到几个像素的算点按，照常交给 xterm（点一下弹键盘）；松手时还有速度就接着滑一阵慢慢停

  const TAP_SLOP = 8
  let touch = null
  let glide = 0
  const rowHeight = () => host.clientHeight / Math.max(term.rows, 1)
  const scrollBy = (lines) => {
    if (lines === 0) return
    if (term.buffer.active.type === 'alternate') {
      const key = keyText(lines < 0 ? 'up' : 'down')
      for (let n = Math.min(Math.abs(lines), 20); n > 0; n--) send(utf8.encode(key))
    } else term.scrollLines(lines)
  }
  /** 攒着的像素够一行就滚一行，零头留着 */
  const drift = (state, dy) => {
    state.rest += dy
    const lines = Math.trunc(state.rest / rowHeight())
    if (lines !== 0) {
      state.rest -= lines * rowHeight()
      scrollBy(-lines)
    }
  }
  host.addEventListener(
    'touchstart',
    (event) => {
      cancelAnimationFrame(glide)
      if (event.touches.length !== 1) return
      const y = event.touches[0].clientY
      touch = { y, startY: y, moving: false, rest: 0, at: performance.now(), speed: 0 }
    },
    { capture: true, passive: true },
  )
  host.addEventListener(
    'touchmove',
    (event) => {
      if (!touch || event.touches.length !== 1) return
      const y = event.touches[0].clientY
      if (!touch.moving && Math.abs(y - touch.startY) < TAP_SLOP) return
      touch.moving = true
      event.preventDefault()
      event.stopPropagation()
      const now = performance.now()
      const dy = y - touch.y
      touch.speed = dy / Math.max(now - touch.at, 1)
      touch.y = y
      touch.at = now
      drift(touch, dy)
    },
    { capture: true, passive: false },
  )
  host.addEventListener(
    'touchend',
    (event) => {
      if (!touch) return
      const state = touch
      touch = null
      if (!state.moving) return
      event.preventDefault()
      event.stopPropagation()
      // 松手时的速度（像素每毫秒），每帧乘一个系数慢下来
      let speed = state.speed
      let last = performance.now()
      const step = (now) => {
        const dt = now - last
        last = now
        speed *= 0.95 ** (dt / 16)
        if (Math.abs(speed) < 0.05) return
        drift(state, speed * dt)
        glide = requestAnimationFrame(step)
      }
      glide = requestAnimationFrame(step)
    },
    { capture: true, passive: false },
  )

  // ---------- 大小 ----------
  // WebView 跟着 RN 那头的框变大变小（转屏、键盘弹起收起时每一帧都在变），停下来再量

  let fitTimer = 0
  window.addEventListener('resize', () => {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(() => {
      fit.fit()
      // 键盘弹起之后光标那一行要露出来
      term.scrollToBottom()
    }, FIT_DELAY_MS)
  })
  term.onResize(({ rows, cols }) => post({ t: 'size', rows, cols }))

  // ---------- 统计（测量用） ----------

  if (config.stats) {
    let gaps = []
    let last = performance.now()
    const tick = (now) => {
      gaps.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    setInterval(() => {
      const sorted = [...gaps].sort((a, b) => a - b)
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
      post({
        t: 'frames',
        count: sorted.length,
        p95: Math.round(at(0.95) * 10) / 10,
        max: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
        bytes: written,
      })
      gaps = []
      written = 0
    }, 1000)
  }

  // ---------- 收消息 ----------

  window.__litch = (message) => {
    switch (message.t) {
      case 'start':
        start(message)
        break
      case 'ops':
        ops(message)
        break
      case 'state':
        running = message.running
        term.options.disableStdin = !running
        break
      case 'key': {
        const text = keyText(message.k)
        if (text) typed(text)
        break
      }
      case 'text':
        typed(message.d)
        break
      case 'ctrl':
        ctrl = message.on
        break
      case 'focus':
        // 焦点还在输入框上、键盘却被收了（关掉对话框之后常这样）：再 focus 一次系统不会弹键盘，
        // 先让开焦点、下一拍再拿回来
        if (textarea && document.activeElement === textarea) {
          textarea.blur()
          setTimeout(() => term.focus(), 0)
        } else term.focus()
        break
      case 'blur':
        term.blur()
        textarea?.blur()
        break
      case 'theme':
        term.options.theme = message.theme
        document.body.style.background = message.theme.background
        break
      case 'clear':
        term.clear()
        break
    }
  }
  post({ t: 'ready', rows: term.rows, cols: term.cols })
})()
