// 和 PDF.js 主模块处于同一作用域。只用 getDocument/PDFWorker，不装 viewer、动作、注释或脚本层。
const config = window.__litchPreview
const post = (value) => window.ReactNativeWebView?.postMessage(JSON.stringify(value))
let port, worker, workerUrl, loading, documentProxy, rendering, currentPage, canvas
let closed = false
let busy = false
let releaseGestures = () => {}
let timer
const dispose = () => {
  if (closed) return
  closed = true
  clearTimeout(timer)
  releaseGestures()
  rendering?.cancel()
  port?.terminate()
  if (workerUrl) URL.revokeObjectURL(workerUrl)
  worker?.destroy()
  void loading?.destroy().catch(() => {})
  if (canvas) canvas.width = canvas.height = 0
}
const fail = (reason) => {
  if (closed) return
  post({ kind: 'failed', reason })
  dispose()
}
const deadline = () => {
  clearTimeout(timer)
  timer = setTimeout(() => fail('timeout'), PDF_TIMEOUT)
}
window.addEventListener('pagehide', dispose, { once: true })
window.addEventListener('error', () => fail('invalid'))
window.addEventListener('unhandledrejection', () => fail('invalid'))

async function showPage(number) {
  if (
    busy ||
    closed ||
    !documentProxy ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > documentProxy.numPages
  )
    return
  busy = true
  deadline()
  try {
    releaseGestures()
    currentPage?.cleanup()
    if (canvas) {
      canvas.width = canvas.height = 0
      canvas.remove()
    }
    currentPage = await documentProxy.getPage(number)
    if (closed) return
    const size = currentPage.getViewport({ scale: 1 })
    if (!validSize(size)) return fail('size')
    const scale = Math.min(2, Math.sqrt(PDF_PAGE_PIXELS / (size.width * size.height)))
    const viewport = currentPage.getViewport({ scale })
    canvas = document.createElement('canvas')
    canvas.id = 'stage'
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    document.body.append(canvas)
    rendering = currentPage.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      annotationMode: 0,
    })
    await rendering.promise
    if (closed) return
    releaseGestures = previewGestures(canvas, canvas.width, canvas.height)
    clearTimeout(timer)
    post({ kind: 'ready', page: number, pages: documentProxy.numPages })
  } catch {
    fail('invalid')
  } finally {
    busy = false
  }
}
window.__litchPage = showPage

try {
  deadline()
  document.body.style.background = config.background
  const packed = window.__litchPdf
  delete window.__litchPdf
  const bytes = Uint8Array.from(atob(config.data), (char) => char.charCodeAt(0))
  config.data = ''
  if (!bytes.length || bytes.length > PDF_BYTES) throw new Error('PDF size')
  // blob Worker 继承页面的 connect-src none；额外覆盖防止库误接入网络。
  workerUrl = URL.createObjectURL(
    new Blob(
      [
        packed.worker,
        ';globalThis.fetch=async()=>{throw new Error("Network disabled")};globalThis.XMLHttpRequest=class{constructor(){throw new Error("Network disabled")}};',
      ],
      { type: 'text/javascript' },
    ),
  )
  port = new Worker(workerUrl, { type: 'module', name: 'litch-mobile-pdf' })
  // WebView 的模块 worker 异步取脚本；此时撤销 URL 会只有 error 事件、没有错误信息。
  // 等文档加载完成（worker 已握手）或销毁时再释放。
  delete packed.worker
  port.addEventListener('error', () => fail('invalid'))
  worker = PDFWorker.create({ port })
  class LocalData {
    async fetch({ kind, filename }) {
      const folder = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[
        kind
      ]
      const value =
        folder && /^[A-Za-z0-9_.-]+$/.test(filename) ? packed.assets[`${folder}/${filename}`] : null
      if (!value) throw new Error('Unbundled PDF resource')
      return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
    }
  }
  loading = getDocument({
    data: bytes,
    worker,
    BinaryDataFactory: LocalData,
    useWorkerFetch: false,
    useSystemFonts: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: true,
    maxImageSize: 8_000_000,
    canvasMaxAreaInBytes: 16_000_000,
    isOffscreenCanvasSupported: true,
    isImageDecoderSupported: false,
    useWasm: true,
    verbosity: 0,
  })
  loading.onPassword = () => fail('encrypted')
  documentProxy = await loading.promise
  URL.revokeObjectURL(workerUrl)
  workerUrl = undefined
  if (!closed) {
    if (documentProxy.numPages > PDF_PAGES) fail('pages')
    else await showPage(1)
  }
} catch (error) {
  fail(error?.name === 'PasswordException' ? 'encrypted' : 'invalid')
}
