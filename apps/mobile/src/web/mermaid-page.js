// 画图页：藏在应用根上的 WebView 里（scripts/build-webview-mermaid.mjs 把它和 mermaid 拼成一页，内嵌成字符串）。
// 一次画一张：mermaid 的配置是全局的，换配置和画图要连在一起。画出来的 SVG 原样交回（全屏页用），
// 再按卡片的大小在画布上画一张 PNG 缩略图（对话里用原生的 Image 显示，滚动时不碰 WebView）。
// 标签用 SVG 的文字、不用 foreignObject（配置里 htmlLabels: false），画布不会因此被“污染”而导不出图。
//
// 和 RN 的约定。进来的经 window.__litch(消息)（RN 用 injectJavaScript 调），出去的经 ReactNativeWebView.postMessage(JSON)：
//   进 {t:'draw', id, source, config, box}  画一张。box：卡片能放图的宽高（dp）、像素密度 scale、最多放大几倍 max
//   出 {t:'ready'}                          页面和 mermaid 都装好了
//   出 {t:'drawn', id, svg, png, width, height}  画好了。png 是 data: 地址，width、height 是缩略图该显示的大小（dp）
//   出 {t:'failed', id, reason}             画不出来（语法错等），reason 是错误的第一行
//   出 {t:'error', message}                 页面里出的错
;(() => {
  const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
  window.addEventListener('error', (event) => post({ t: 'error', message: String(event.message) }))
  /** 缩略图一边最多这么多像素：再大画布会很吃内存，卡片上也看不出差别 */
  const MAX_PIXELS = 4096
  let queue = Promise.resolve()
  let serial = 0

  window.__litch = (message) => {
    if (message?.t !== 'draw') return
    queue = queue.then(() => draw(message))
  }

  async function draw({ id, source, config, box }) {
    serial += 1
    const name = `litch-mmd-${serial}`
    try {
      window.mermaid.initialize(config)
      const { svg } = await window.mermaid.render(name, source)
      const thumb = await raster(svg, box)
      post({ t: 'drawn', id, svg, ...thumb })
    } catch (error) {
      post({ t: 'failed', id, reason: firstLine(error) })
    } finally {
      // 画不出来时 mermaid 可能把量尺寸用的临时节点留在页面里
      for (const node of document.querySelectorAll(`#${name}, #d${name}`)) node.remove()
    }
  }

  /** 图本来的大小：取 viewBox，没有就取宽高属性 */
  function naturalSize(root) {
    const box = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
    if (box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] }
    const width = Number.parseFloat(root.getAttribute('width') || '')
    const height = Number.parseFloat(root.getAttribute('height') || '')
    if (width > 0 && height > 0) return { width, height }
    throw new Error('no size')
  }

  /** 等比缩进卡片（宽度能撑满就撑满，小图最多放大 max 倍），按像素密度画成 PNG */
  async function raster(svg, box) {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    const size = naturalSize(root)
    const fit = Math.min(box.width / size.width, box.height / size.height, box.max)
    const width = size.width * fit
    const height = size.height * fit
    const density = Math.min(box.scale, MAX_PIXELS / Math.max(width, height))
    const pixelWidth = Math.max(1, Math.round(width * density))
    const pixelHeight = Math.max(1, Math.round(height * density))
    // 按要的像素大小重排 SVG（mermaid 给的是 width="100%" 加 max-width），矢量画到画布上是清楚的
    root.setAttribute('width', String(pixelWidth))
    root.setAttribute('height', String(pixelHeight))
    root.removeAttribute('style')
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    canvas.getContext('2d').drawImage(image, 0, 0, pixelWidth, pixelHeight)
    return { png: canvas.toDataURL('image/png'), width, height }
  }

  function firstLine(error) {
    const text = error instanceof Error ? error.message : String(error)
    return (
      text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || text
    )
  }

  post({ t: 'ready' })
})()
