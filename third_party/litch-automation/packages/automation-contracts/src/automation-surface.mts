// CU 与浏览器共用的预览坐标、动作阶段和版本。无平台依赖，不注册协议或工具。

export interface AutomationPoint {
  readonly x: number
  readonly y: number
}

export interface AutomationRect extends AutomationPoint {
  readonly width: number
  readonly height: number
}

export interface AutomationSurfaceVersion {
  readonly surfaceId: string
  /** 执行端身份，防止不同设备上同名窗口互相串帧。 */
  readonly executorId: string
  /** 窗口重建或执行端重连后更换；同代内 seq 单调递增。 */
  readonly generation: number
  readonly geometryRevision: number
}

export interface AutomationSurface extends AutomationSurfaceVersion {
  readonly kind: 'nativeWindow' | 'browserViewport'
  /** 原生窗口内容逻辑点 / 浏览器 viewport CSS px，原点均为内容左上角。 */
  readonly width: number
  readonly height: number
}

export interface AutomationFrameGeometry {
  readonly pixelWidth: number
  readonly pixelHeight: number
  /** 帧内对应完整 surface 的像素矩形；可排除标题栏、阴影等填充。 */
  readonly contentRect: AutomationRect
  /** 已烘焙代理光标时，显示端不再绘制第二个。 */
  readonly cursorComposited: boolean
}

export interface AutomationPointerSample extends AutomationSurfaceVersion {
  readonly actionId: string
  readonly seq: number
  /** 执行端单调时钟，微秒；不能直接与另一台设备的时钟相减。 */
  readonly timeUs: number
  readonly phase: 'planned' | 'dispatched' | 'completed' | 'failed' | 'cancelled'
  readonly kind: 'move' | 'click' | 'drag' | 'scroll' | 'semantic'
  /** 没有可靠命中点时省略，呈现层应隐藏指针而非使用旧位置。 */
  readonly position?: AutomationPoint
  readonly path?: ReadonlyArray<AutomationPoint & { readonly offsetMs: number }>
  readonly button?: 'left' | 'right' | 'middle'
  readonly pressed?: boolean
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function validRect(rect: AutomationRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    positive(rect.width) &&
    positive(rect.height) &&
    Number.isFinite(rect.x + rect.width) &&
    Number.isFinite(rect.y + rect.height)
  )
}

function contains(rect: AutomationRect, point: AutomationPoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  )
}

/** object-fit:contain 后内容在视图中的矩形。视图单位为 CSS px，可有负的布局偏移。 */
export function automationContentRect(
  frame: AutomationFrameGeometry,
  viewport: AutomationRect,
): AutomationRect | null {
  if (
    !positive(frame.pixelWidth) ||
    !positive(frame.pixelHeight) ||
    !validRect(frame.contentRect) ||
    !validRect(viewport)
  )
    return null
  const content = frame.contentRect
  if (
    content.x < 0 ||
    content.y < 0 ||
    content.x + content.width > frame.pixelWidth ||
    content.y + content.height > frame.pixelHeight
  )
    return null
  const scale = Math.min(viewport.width / frame.pixelWidth, viewport.height / frame.pixelHeight)
  const rect = {
    x: viewport.x + (viewport.width - frame.pixelWidth * scale) / 2 + content.x * scale,
    y: viewport.y + (viewport.height - frame.pixelHeight * scale) / 2 + content.y * scale,
    width: content.width * scale,
    height: content.height * scale,
  }
  return validRect(rect) ? rect : null
}

/** 内容坐标 → 呈现坐标。拒绝越界，不把错误的点击夹到窗口边缘。 */
export function automationPointToView(
  point: AutomationPoint,
  surface: AutomationSurface,
  frame: AutomationFrameGeometry,
  viewport: AutomationRect,
): AutomationPoint | null {
  if (!positive(surface.width) || !positive(surface.height)) return null
  if (!contains({ x: 0, y: 0, width: surface.width, height: surface.height }, point)) return null
  const rect = automationContentRect(frame, viewport)
  if (!rect) return null
  const result = {
    x: rect.x + (point.x / surface.width) * rect.width,
    y: rect.y + (point.y / surface.height) * rect.height,
  }
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null
}

/** 呈现坐标 → 内容坐标；信箱留白、标题栏、阴影不映射成输入点。仅换算，不授权输入。 */
export function automationPointFromView(
  point: AutomationPoint,
  surface: AutomationSurface,
  frame: AutomationFrameGeometry,
  viewport: AutomationRect,
): AutomationPoint | null {
  if (!positive(surface.width) || !positive(surface.height)) return null
  const rect = automationContentRect(frame, viewport)
  if (!rect || !contains(rect, point)) return null
  const result = {
    x: ((point.x - rect.x) / rect.width) * surface.width,
    y: ((point.y - rect.y) / rect.height) * surface.height,
  }
  return contains({ x: 0, y: 0, width: surface.width, height: surface.height }, result)
    ? result
    : null
}

/** 同一设备、窗口代次与几何版本才可一起呈现；窗口编号相同不代表同一个窗口。 */
export function sameAutomationSurface(
  left: AutomationSurfaceVersion,
  right: AutomationSurfaceVersion,
): boolean {
  return (
    left.surfaceId.length > 0 &&
    left.executorId.length > 0 &&
    Number.isSafeInteger(left.generation) &&
    left.generation >= 0 &&
    Number.isSafeInteger(left.geometryRevision) &&
    left.geometryRevision >= 0 &&
    left.surfaceId === right.surfaceId &&
    left.executorId === right.executorId &&
    left.generation === right.generation &&
    left.geometryRevision === right.geometryRevision
  )
}

/** 新连接先取 snapshot；本函数只判断版本/顺序，不重放动作，也不按跨机墙钟判断过期。 */
export function isCurrentAutomationPointer(
  surface: AutomationSurface,
  sample: AutomationPointerSample,
  previous?: AutomationPointerSample,
): boolean {
  if (
    !sameAutomationSurface(surface, sample) ||
    !Number.isSafeInteger(sample.seq) ||
    sample.seq < 0 ||
    !Number.isSafeInteger(sample.timeUs) ||
    sample.timeUs < 0
  )
    return false
  return !previous || !sameAutomationSurface(sample, previous) || sample.seq > previous.seq
}
