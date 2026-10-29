// 此 bundle 只注入顶层文档的 isolated world；没有网页消息入口，也不派发输入。
import type {
  AutomationPointerSample,
  AutomationSurface,
} from '../../../packages/protocol/src/automation-surface.mjs'
import {
  type AutomationPointerRenderer,
  createAutomationPointer,
} from '../../../packages/ui/src/automation-preview/pointer-renderer.ts'

let renderer: AutomationPointerRenderer | null = null
let surface: AutomationSurface | null = null
let stamp = ''
let revision = 0
let releaseCapture: (() => void) | null = null
let capture: Promise<unknown> | null = null
let last: AutomationPointerSample | null = null

function geometry() {
  const view = visualViewport
  const width = view?.width ?? innerWidth
  const height = view?.height ?? innerHeight
  const current = JSON.stringify([
    width,
    height,
    scrollX,
    scrollY,
    devicePixelRatio,
    view?.offsetLeft,
    view?.offsetTop,
    view?.scale,
  ])
  if (stamp !== current) {
    revision++
    stamp = current
  }
  if (!surface) throw new Error('Pointer is not configured')
  surface = { ...surface, geometryRevision: revision, width, height }
  const frame = {
    pixelWidth: width,
    pixelHeight: height,
    contentRect: { x: 0, y: 0, width, height },
    cursorComposited: false,
  }
  renderer?.geometry(surface, frame)
  return { surface, frame, stamp }
}
const api = {
  configure(next: AutomationSurface, leaseId: string) {
    renderer?.dispose()
    surface = next
    stamp = ''
    revision = 0
    last = null
    const current = geometry()
    renderer = createAutomationPointer(document.documentElement, {
      ...current,
      fixed: true,
      color: 'Highlight',
      outlineColor: 'HighlightText',
      reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    })
    renderer.element.dataset.litchChromePointer = leaseId
    return current
  },
  geometry,
  focusPoint() {
    const target = document.activeElement
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
    )
      return null
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  },
  async update(sample: AutomationPointerSample) {
    const current = geometry()
    if (sample.geometryRevision !== current.surface.geometryRevision)
      throw new Error('Pointer geometry changed')
    last = sample
    return renderer?.update(sample)
  },
  async hide() {
    if (!renderer || releaseCapture) throw new Error('Pointer capture is unavailable or busy')
    let ready!: () => void
    const begun = new Promise<void>((resolve) => {
      ready = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    capture = renderer.withoutPointer(async () => {
      ready()
      await release
    })
    await begun
  },
  async restore() {
    releaseCapture?.()
    releaseCapture = null
    await capture
    capture = null
  },
  dispose() {
    releaseCapture?.()
    releaseCapture = null
    renderer?.dispose()
    renderer = null
    surface = null
    last = null
  },
  // 只有隔离验收的 CDP 能观察这个 world，产品页面的主 world 看不到。
  status() {
    return { last, surface, connected: renderer?.element.isConnected ?? false }
  },
}
Object.assign(globalThis, { __litchChromePointer: api })
