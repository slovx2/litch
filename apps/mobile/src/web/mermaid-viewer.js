// 全屏看图页（scripts/build-webview-mermaid.mjs 拼成一页，内嵌成字符串，src/detail/mermaid/MermaidViewer.tsx 用）。
// 画好的 SVG 按本来的大小放进来，再整体平移缩放：双指缩放（以两指中点为中心）、单指拖动、双击复原；
// 网页预览里还能用滚轮缩放（以鼠标处为中心）。刚打开和转屏后是“整张放得下、最多放大两倍”的那一档。
// SVG 是画图页在严格模式下画出、mermaid 自己净化过的。
// 启动参数在 window.__litchConfig（RN 把它写在页面最前面）：svg、background。
;(() => {
  const config = window.__litchConfig || {}
  const MIN_SCALE = 0.2
  const MAX_SCALE = 10
  /** 四周留的边（px） */
  const MARGIN = 16
  const DOUBLE_TAP_MS = 300
  /** 手指动过这么远就不算点 */
  const SLOP = 10

  document.body.style.background = config.background || 'transparent'
  const stage = document.createElement('div')
  stage.id = 'stage'
  stage.innerHTML = config.svg || ''
  document.body.append(stage)
  const figure = stage.querySelector('svg')
  if (!figure) return

  // 按图本来的大小画，再整体缩放；不然它会照页面宽度缩成一条
  const box = figure.viewBox.baseVal
  const width = box?.width || figure.getBoundingClientRect().width || 1
  const height = box?.height || figure.getBoundingClientRect().height || 1
  figure.removeAttribute('style')
  figure.setAttribute('width', String(width))
  figure.setAttribute('height', String(height))

  let view = { x: 0, y: 0, scale: 1 }
  const clamp = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
  const place = () => {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  }
  const fit = () => {
    const room = { width: window.innerWidth, height: window.innerHeight }
    // 视图还没排好大小时先不放，排好会有 resize
    if (!room.width || !room.height) return
    const scale = Math.min(
      2,
      (room.width - MARGIN * 2) / width,
      (room.height - MARGIN * 2) / height,
    )
    view = {
      scale,
      x: (room.width - width * scale) / 2,
      y: (room.height - height * scale) / 2,
    }
    place()
  }
  /** 以屏幕上的 (x, y) 为中心缩放到 scale：那一点缩放前后不动 */
  const zoomAt = (x, y, scale, from = view) => {
    const ratio = scale / from.scale
    view = { scale, x: x - (x - from.x) * ratio, y: y - (y - from.y) * ratio }
  }
  fit()
  window.addEventListener('resize', fit)

  /** 按在屏幕上的手指（指针） */
  const pointers = new Map()
  /** 这一次手势开始时：两指的距离和中点、当时的视图；单指时是按下的位置 */
  let gesture = null
  let moved = false
  let lastTap = 0

  const start = () => {
    const points = [...pointers.values()]
    if (points.length >= 2) {
      const [a, b] = points
      gesture = {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: { ...view },
      }
    } else if (points.length === 1) {
      gesture = { point: { ...points[0] }, view: { ...view } }
    } else gesture = null
  }

  document.addEventListener('pointerdown', (event) => {
    if (pointers.size === 0) moved = false
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    document.body.setPointerCapture?.(event.pointerId)
    start()
  })
  document.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId) || !gesture) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = [...pointers.values()]
    if (points.length >= 2 && gesture.distance) {
      const [a, b] = points
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const scale = clamp(
        gesture.view.scale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance),
      )
      // 先按开始时的中点缩放，再跟着两指中点的移动平移
      zoomAt(gesture.mid.x, gesture.mid.y, scale, gesture.view)
      view.x += mid.x - gesture.mid.x
      view.y += mid.y - gesture.mid.y
      moved = true
    } else if (points.length === 1 && gesture.point) {
      const dx = points[0].x - gesture.point.x
      const dy = points[0].y - gesture.point.y
      if (Math.hypot(dx, dy) > SLOP) moved = true
      view = { ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy }
    }
    place()
  })
  const end = (event) => {
    if (!pointers.delete(event.pointerId)) return
    if (pointers.size === 0 && !moved && event.type === 'pointerup') {
      const now = Date.now()
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0
        fit()
      } else lastTap = now
    }
    // 两指松开一指：剩下那一指接着拖，不跳
    start()
  }
  document.addEventListener('pointerup', end)
  document.addEventListener('pointercancel', end)
  document.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      zoomAt(event.clientX, event.clientY, clamp(view.scale * Math.exp(-event.deltaY * 0.002)))
      place()
    },
    { passive: false },
  )
})()
