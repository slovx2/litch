// 和 Computer Use 助手（apps/computer-use）之间的线上格式：每帧 4 字节大端的长度，后面是 UTF-8 的 JSON-RPC 2.0。
// 助手那一头在 apps/computer-use/Sources/LitchComputerUseCore/Wire.swift，常量和方法的形状两边要一致。

/** 通道协议的版本，握手时对不上助手直接断开 */
export const HELPER_PROTOCOL = 1
/** 单帧上限，和助手一样 */
export const MAX_FRAME = 32 * 1024 * 1024

/** 助手错误里的分类（JSON-RPC 错误的 data.kind） */
export type HelperErrorKind =
  | 'unauthorized'
  | 'invalid'
  | 'permission'
  | 'notFound'
  | 'forbidden'
  | 'stopped'
  | 'userActive'
  | 'stale'
  | 'failed'

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
}

export interface HelperApp {
  name: string
  bundleId: string | null
  pid: number
  active: boolean
  windows: number
}

export interface AppStateResult {
  app: { name: string; bundleId: string | null; pid: number }
  window: { title: string | null; width: number; height: number }
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
