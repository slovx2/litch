// 和 Computer Use 助手之间的线上格式：每帧 4 字节大端的长度，后面是 UTF-8 的 JSON-RPC 2.0。两个平台同一套帧。
// macOS 助手（apps/computer-use）那一头在 Sources/LitchComputerUseCore/Wire.swift；Windows 助手（apps/computer-use-win）
// 的方法和形状在下面“Windows 助手”那一段。常量和方法的形状两边要一致。

/** macOS 助手的通道协议版本，握手时对不上助手直接断开 */
export const HELPER_PROTOCOL = 1
/** Windows 助手的通道协议版本（两个平台各自计数） */
export const HELPER_PROTOCOL_WIN = 1
/** 单帧上限，和助手一样 */
export const MAX_FRAME = 32 * 1024 * 1024

/** 助手错误里的分类（JSON-RPC 错误的 data.kind） */
export type HelperErrorKind =
  | 'unauthorized'
  | 'invalid'
  | 'permission'
  | 'capturePending'
  | 'captureDenied'
  | 'captureFailed'
  | 'notFound'
  | 'stopped'
  | 'userActive'
  | 'stale'
  | 'failed'
  // 以下三种只有 Windows 助手会报
  /** 目标窗口的完整性级别高于助手（以管理员身份运行的窗口） */
  | 'elevated'
  /** 输入桌面不是 Default（锁屏、UAC 提示），或者前台是锁屏 */
  | 'locked'
  /** 切不到前台 */
  | 'foreground'

export class HelperError extends Error {
  readonly kind: HelperErrorKind
  constructor(kind: HelperErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_FRAME) throw new Error(`frame too large: ${body.length}`)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

/** 把收到的字节攒起来切帧 */
export class FrameReader {
  private chunks: Buffer[] = []
  private size = 0

  push(data: Buffer): void {
    this.chunks.push(data)
    this.size += data.length
  }

  /** 下一帧；不够一帧回 undefined；长度超限或不是 JSON 时抛错（调用方断开） */
  next(): unknown {
    if (this.size < 4) return undefined
    // 先只拼出够读长度的开头，整帧没到齐之前不去拼大块（截图一帧几 MB，按 64 KB 一块到）
    const head = (this.chunks[0]?.length ?? 0) >= 4 ? this.chunks[0] : Buffer.concat(this.chunks)
    const length = head?.readUInt32BE(0) ?? 0
    if (length > MAX_FRAME) throw new Error(`frame too large: ${length}`)
    if (this.size < 4 + length) return undefined
    const all = this.chunks.length === 1 && head ? head : Buffer.concat(this.chunks)
    const body = all.subarray(4, 4 + length)
    const rest = all.subarray(4 + length)
    this.chunks = rest.length > 0 ? [rest] : []
    this.size = rest.length
    return JSON.parse(body.toString('utf8'))
  }
}

// —— 方法的参数和结果（和 Engine.swift 开头的清单一致） ——

export interface HelloResult {
  protocol: number
  pid: number
  version: string | null
  bundleId: string | null
  bundlePath: string
  /** team：按团队号验的（正式版）；token：开发期的一次性令牌 */
  auth: 'team' | 'token' | 'closed'
  teamId: string | null
}

export interface PermissionStatus {
  accessibility: boolean
  screenRecording: boolean
  captureStatus?: 'untested' | 'pending' | 'ready' | 'denied' | 'failed'
}

export interface HelperApp {
  /** 系统显示的名字，跟着系统语言（中文系统上文本编辑叫“文本编辑”） */
  name: string
  /** 应用包的文件名去掉 .app（TextEdit），不跟语言变 */
  fileName: string | null
  bundleId: string | null
  pid: number
  active: boolean
  windows: number
}

export interface AppStateResult {
  app: { name: string; bundleId: string | null; pid: number }
  window: {
    title: string | null
    width: number
    height: number
    id?: number
    observedAt?: number
    capturedAt?: number
  }
  screenshot: { mime: string; data: string; width: number; height: number }
  text: string
  diff: boolean
  truncated: boolean
}

export interface ActionResult {
  text: string
}

/** 助手发来的通知：用户按了停止 */
export interface StoppedNotice {
  session: string
  app: string
  bundleId: string
}

// —— Windows 助手的参数和结果 ——

/** 完整性级别 */
export type WinIntegrity = 'low' | 'medium' | 'high' | 'system'

export interface WinHelloResult {
  protocol: number
  pid: number
  version: string | null
  platform: 'win32'
  integrity: WinIntegrity
  uacEnabled: boolean
}

/** 两个平台的握手结果 */
export type HelperHello = HelloResult | WinHelloResult

export const isWinHello = (hello: HelperHello | null | undefined): hello is WinHelloResult =>
  (hello as WinHelloResult | null | undefined)?.platform === 'win32'

export interface WinWindow {
  /** HWND 的数值 */
  id: number
  title: string
  active?: boolean
  minimized?: boolean
}

export interface WinHelperApp {
  /** 打包应用是 AUMID，其余是 exe 的完整路径；比较时不分大小写 */
  appId: string
  /** 开始菜单快捷方式或版本资源里的 FileDescription */
  name: string
  /** exe 的完整路径 */
  exe: string
  aumid: string | null
  pid: number
  active: boolean
  integrity: WinIntegrity
  windows: WinWindow[]
}

/** 界面树的一个节点（编号和文字化在 ax-text.mts） */
export interface WinNode {
  /** UIA RuntimeId 用 "." 连起来；助手在同一窗口的后续动作里凭它找回元素 */
  ref: string
  /** UIA 控件类型名去掉 "Control"：Button、Edit、Text、ListItem…… */
  role: string
  name?: string
  /** ValuePattern 的值（密码框不给，states 里带 password） */
  value?: string
  automationId?: string
  className?: string
  states: string[]
  actions: string[]
  /** 截图像素 */
  frame?: { x: number; y: number; width: number; height: number }
  children: WinNode[]
}

export interface WinAppStateResult {
  app: { appId: string; name: string; exe: string; aumid: string | null; pid: number }
  window: { id: number; title: string; width: number; height: number }
  /** 这个应用的其他窗口（弹出的对话框、菜单也算） */
  windows: { id: number; title: string }[]
  screenshot: {
    /** 截图号：坐标动作要带回去（字符串，原样带回） */
    id: string | number
    mime: string
    data: string
    width: number
    height: number
  } | null
  tree: WinNode
  truncated: boolean
  notes: string[]
}

/** Windows 助手的停止通知（物理 Esc） */
export interface WinStoppedNotice {
  session: string
  appId: string
}

/** 两个平台的停止通知 */
export type HelperStopped = StoppedNotice | WinStoppedNotice
