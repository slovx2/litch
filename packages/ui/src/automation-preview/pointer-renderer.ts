// 不依赖 React/Electron。Chrome 在 isolated world 调用；本模块不监听网页消息，不授权或派发输入。
import {
  type AutomationFrameGeometry,
  type AutomationPointerSample,
  type AutomationSurface,
  automationPointToView,
  isCurrentAutomationPointer,
  sameAutomationSurface,
} from '../../../protocol/src/automation-surface.mts'

export interface PointerArrival {
  sample: AutomationPointerSample
  result: 'arrived' | 'hidden' | 'timedOut' | 'superseded' | 'stale' | 'disposed'
}
export interface PointerRendererOptions {
  surface: AutomationSurface
  frame: AutomationFrameGeometry
  color: string
  outlineColor?: string
  fixed?: boolean
  reducedMotion?: () => boolean
}

export interface AutomationPointerRenderer {
  readonly element: HTMLElement
  geometry(surface: AutomationSurface, frame: AutomationFrameGeometry): void
  update(sample: AutomationPointerSample): Promise<PointerArrival>
  withoutPointer<T>(capture: () => Promise<T>): Promise<T>
  dispose(): void
}

export function createAutomationPointer(
  parent: HTMLElement,
  options: PointerRendererOptions,
): AutomationPointerRenderer {
  const doc = parent.ownerDocument,
    win = doc.defaultView
  if (!win) throw new Error('Pointer renderer requires a document window')
  const host = doc.createElement('div')
  host.dataset.litchAutomationPointer = ''
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:${options.fixed ? 'fixed' : 'absolute'};inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;contain:strict;`
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = doc.createElement('style')
  style.textContent =
    ':host{pointer-events:none!important}svg{position:absolute;left:0;top:0;width:28px;height:32px;overflow:visible}circle{fill:none;stroke:currentColor;stroke-width:2;opacity:0}path{fill:currentColor;stroke:var(--pointer-outline,currentColor);stroke-width:1.4;stroke-linejoin:round}'
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 28 32')
  const path = doc.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', 'M3 2 L3 23 L9 18 L14 28 L18 26 L13 16 L22 16 Z')
  const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'circle')
  ring.setAttribute('cx', '3')
  ring.setAttribute('cy', '2')
  ring.setAttribute('r', '11')
  svg.append(ring, path)
  shadow.append(style, svg)
  parent.append(host)
  svg.style.color = options.color
  svg.style.setProperty('--pointer-outline', options.outlineColor ?? options.color)
  svg.style.display = 'none'
  let surface = options.surface,
    frame = options.frame
  let previous: AutomationPointerSample | undefined
  let current: { x: number; y: number } | null = null
  let disposed = false,
    hidden = 0,
    animation = 0
  let settle: ((result: PointerArrival['result']) => void) | null = null
  const viewport = () => ({ x: 0, y: 0, width: host.clientWidth, height: host.clientHeight })
  let lastViewport = viewport()
  const finish = (result: PointerArrival['result']) => {
    win.cancelAnimationFrame(animation)
    settle?.(result)
    settle = null
  }
  const draw = (x: number, y: number) => {
    svg.style.transform = `translate(${x - 3}px,${y - 2}px)`
    current = { x, y }
  }
  const paint = (sample: AutomationPointerSample) => {
    svg.style.display = sample.position && !frame.cursorComposited ? '' : 'none'
    ring.style.opacity = sample.phase === 'dispatched' && sample.pressed ? '0.8' : '0'
  }
  const remap = () => {
    if (!previous?.position) return
    const point = automationPointToView(previous.position, surface, frame, viewport())
    paint(previous)
    if (point) draw(point.x, point.y)
    else svg.style.display = 'none'
  }
  const resize = new win.ResizeObserver(() => {
    const next = viewport()
    if (next.width === lastViewport.width && next.height === lastViewport.height) return
    lastViewport = next
    finish('superseded')
    remap()
  })
  resize.observe(parent)
  return {
    element: host,
    geometry(next: AutomationSurface, nextFrame: AutomationFrameGeometry) {
      if (disposed) return
      // 相同 surface 的画面裁剪也可能改变映射；旧动画不能继续返回到位。
      if (
        frame.pixelWidth !== nextFrame.pixelWidth ||
        frame.pixelHeight !== nextFrame.pixelHeight ||
        frame.cursorComposited !== nextFrame.cursorComposited ||
        frame.contentRect.x !== nextFrame.contentRect.x ||
        frame.contentRect.y !== nextFrame.contentRect.y ||
        frame.contentRect.width !== nextFrame.contentRect.width ||
        frame.contentRect.height !== nextFrame.contentRect.height
      ) {
        finish('superseded')
      }
      if (!sameAutomationSurface(surface, next)) {
        finish('superseded')
        previous = undefined
        current = null
        svg.style.display = 'none'
      }
      surface = next
      frame = nextFrame
      remap()
    },
    update(sample: AutomationPointerSample): Promise<PointerArrival> {
      if (disposed) return Promise.resolve({ sample, result: 'disposed' })
      if (!isCurrentAutomationPointer(surface, sample, previous))
        return Promise.resolve({ sample, result: 'stale' })
      finish('superseded')
      previous = sample
      paint(sample)
      const target =
        sample.position && automationPointToView(sample.position, surface, frame, viewport())
      if (!target) {
        svg.style.display = 'none'
        return Promise.resolve({ sample, result: 'hidden' })
      }
      if (doc.hidden || hidden || frame.cursorComposited || !host.isConnected) {
        draw(target.x, target.y)
        return Promise.resolve({ sample, result: 'hidden' })
      }
      const durationMs = !current || options.reducedMotion?.() ? 0 : 120
      lastViewport = viewport()
      const from = current ?? target,
        began = win.performance.now()
      const path = sample.path
        ?.flatMap((point) => {
          const mapped = automationPointToView(point, surface, frame, viewport())
          return mapped && Number.isFinite(point.offsetMs) && point.offsetMs >= 0
            ? [{ ...mapped, at: point.offsetMs }]
            : []
        })
        .sort((a, b) => a.at - b.at)
      return new Promise((resolve) => {
        // 后台节流、页面关闭时也有短上限；回执只描述呈现，不等于动作获得授权。
        const timer = win.setTimeout(() => {
          draw(target.x, target.y)
          finish(doc.hidden ? 'hidden' : 'timedOut')
        }, 160)
        settle = (result) => {
          win.clearTimeout(timer)
          resolve({ sample, result })
        }
        const step = (now: number) => {
          const t = durationMs === 0 ? 1 : Math.min(1, (now - began) / durationMs)
          const duration = path?.at(-1)?.at ?? 0
          if (path?.length && duration > 0 && t < 1) {
            const at = t * duration
            const right = path.findIndex((point) => point.at >= at)
            const a = path[Math.max(0, right - 1)],
              b = path[Math.max(0, right)]
            if (a && b) {
              const part = b.at === a.at ? 1 : (at - a.at) / (b.at - a.at)
              draw(a.x + (b.x - a.x) * part, a.y + (b.y - a.y) * part)
            }
          } else draw(from.x + (target.x - from.x) * t, from.y + (target.y - from.y) * t)
          if (t === 1)
            animation = win.requestAnimationFrame(() =>
              finish(
                doc.hidden || hidden || frame.cursorComposited || !host.isConnected
                  ? 'hidden'
                  : 'arrived',
              ),
            )
          else animation = win.requestAnimationFrame(step)
        }
        animation = win.requestAnimationFrame(step)
      })
    },
    async withoutPointer<T>(capture: () => Promise<T>): Promise<T> {
      hidden++
      host.style.visibility = 'hidden'
      finish('hidden')
      try {
        await new Promise<void>((resolve) => {
          const timeout = win.setTimeout(resolve, 120)
          win.requestAnimationFrame(() =>
            win.requestAnimationFrame(() => {
              win.clearTimeout(timeout)
              resolve()
            }),
          )
        })
        return await capture()
      } finally {
        hidden--
        if (!hidden && !disposed) host.style.visibility = ''
      }
    },
    dispose() {
      disposed = true
      finish('disposed')
      resize.disconnect()
      host.remove()
      previous = undefined
      current = null
    },
  }
}
