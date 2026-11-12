// 此 bundle 只注入顶层文档的 isolated world；没有网页消息入口，也不派发输入。
import type {
  AutomationPointerSample,
  AutomationSurface,
} from '../../automation-contracts/src/automation-surface.mjs'
import {
  type AutomationPointerRenderer,
  createAutomationPointer,
  type PointerArrival,
} from '../../browser/src/pointer-renderer.mjs'

/** 光标只短暂显示；外部撤销 debugger 后也不依赖宿主继续发清理命令。 */
export const CHROME_POINTER_LIFETIME_MS = 2000

export function installPointerWorld(): void {
  let renderer: AutomationPointerRenderer | null = null
  let surface: AutomationSurface | null = null
  let stamp = ''
  let revision = 0
  let releaseCapture: (() => void) | null = null
  let capture: Promise<unknown> | null = null
  let last: AutomationPointerSample | null = null
  let lease = ''
  let expiry: number | undefined
  let expiresAt = 0
  let fading: Animation | undefined
  let arrival: {
    sample: AutomationPointerSample
    result: PointerArrival['result'] | 'pending'
  } | null = null

  function expire() {
    window.clearTimeout(expiry)
    expiry = undefined
    fading?.cancel()
    fading = undefined
    releaseCapture?.()
    releaseCapture = null
    renderer?.dispose()
    renderer = null
    arrival = null
  }
  function refresh() {
    window.clearTimeout(expiry)
    expiresAt = Date.now() + CHROME_POINTER_LIFETIME_MS
    // 后台页面的 JS 计时器可能节流；动画在下一次绘制时按时间线隐藏过期光标。
    fading?.cancel()
    fading = renderer?.element.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }],
      {
        duration: CHROME_POINTER_LIFETIME_MS,
        fill: 'forwards',
      },
    )
    expiry = window.setTimeout(expire, CHROME_POINTER_LIFETIME_MS)
  }

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
    if (renderer && Date.now() >= expiresAt) expire()
    if (!renderer) {
      // 旧 isolated world 无法访问时，DOM 仍共享；清掉残留后再创建唯一的光标。
      for (const node of document.querySelectorAll('[data-litch-chrome-pointer]')) node.remove()
      renderer = createAutomationPointer(document.documentElement, {
        surface,
        frame,
        fixed: true,
        color: 'Highlight',
        outlineColor: 'HighlightText',
        reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      })
      renderer.element.dataset.litchChromePointer = lease
      refresh()
    } else renderer.geometry(surface, frame)
    return { surface, frame, stamp }
  }
  const api = {
    configure(next: AutomationSurface, leaseId: string) {
      expire()
      lease = leaseId
      surface = next
      stamp = ''
      revision = 0
      last = null
      arrival = null
      return geometry()
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
    update(sample: AutomationPointerSample) {
      const current = geometry()
      if (sample.geometryRevision !== current.surface.geometryRevision)
        throw new Error('Pointer geometry changed')
      last = sample
      refresh()
      return renderer?.update(sample)
    },
    prepare(sample: AutomationPointerSample) {
      const work = api.update(sample)
      arrival = { sample, result: 'pending' }
      void work?.then((receipt) => {
        if (arrival?.sample === sample) arrival = receipt
      })
      return arrival
    },
    arrival() {
      return arrival
    },
    async hide() {
      if (!renderer) return
      if (releaseCapture) throw new Error('Pointer capture is busy')
      let ready!: () => void
      const begun = new Promise<void>((resolve) => {
        ready = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseCapture = resolve
      })
      // CDP 会在捕获时更新样式；后台无帧时不把快照也卡在隐藏动画上。
      capture = renderer.withoutPointer(async () => {
        ready()
        await release
      }, false)
      await begun
    },
    async restore() {
      releaseCapture?.()
      releaseCapture = null
      await capture
      capture = null
    },
    dispose() {
      expire()
      surface = null
      last = null
      arrival = null
    },
    // 只有隔离验收的 CDP 能观察这个 world，产品页面的主 world 看不到。
    status() {
      return { last, surface, expiresAt, connected: renderer?.element.isConnected ?? false }
    },
  }
  Object.assign(globalThis, { __litchChromePointer: api })
}
