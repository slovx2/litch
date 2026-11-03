// 图片与 PDF 共用的视口；只变换一张图/画布，不因缩放重新分配大位图。
export function previewGestures(stage, width, height) {
  let view = { x: 0, y: 0, scale: 1 }
  let fitted = 1
  const points = new Map()
  let start = null
  let moved = false
  let lastTap = 0
  const paint = () => {
    stage.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`
  }
  const fit = () => {
    fitted = Math.min(1, (innerWidth - 24) / width, (innerHeight - 24) / height)
    view = {
      x: (innerWidth - width * fitted) / 2,
      y: (innerHeight - height * fitted) / 2,
      scale: fitted,
    }
    paint()
  }
  const restart = () => {
    const [a, b] = [...points.values()]
    start = a ? { a, b, view: { ...view } } : null
  }
  const down = (event) => {
    if (!points.size) moved = false
    points.set(event.pointerId, { x: event.clientX, y: event.clientY })
    document.body.setPointerCapture(event.pointerId)
    restart()
  }
  const move = (event) => {
    if (!points.has(event.pointerId) || !start) return
    points.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const [a, b] = [...points.values()]
    if (b && start.b) {
      const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)
      const scale = Math.max(
        fitted / 2,
        Math.min(
          fitted * 8,
          (start.view.scale * distance(a, b)) / Math.max(1, distance(start.a, start.b)),
        ),
      )
      const ratio = scale / start.view.scale
      view = {
        scale,
        x: (a.x + b.x) / 2 - ((start.a.x + start.b.x) / 2 - start.view.x) * ratio,
        y: (a.y + b.y) / 2 - ((start.a.y + start.b.y) / 2 - start.view.y) * ratio,
      }
      moved = true
    } else {
      const dx = a.x - start.a.x,
        dy = a.y - start.a.y
      moved ||= Math.hypot(dx, dy) > 8
      view = { ...start.view, x: start.view.x + dx, y: start.view.y + dy }
    }
    paint()
  }
  const up = (event) => {
    if (!points.delete(event.pointerId)) return
    if (!points.size && !moved && event.type === 'pointerup') {
      const now = Date.now()
      if (now - lastTap < 300) fit()
      lastTap = now
    }
    restart()
  }
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up }
  for (const [name, handler] of Object.entries(events)) document.addEventListener(name, handler)
  window.addEventListener('resize', fit)
  fit()
  return () => {
    for (const [name, handler] of Object.entries(events))
      document.removeEventListener(name, handler)
    window.removeEventListener('resize', fit)
    points.clear()
  }
}
