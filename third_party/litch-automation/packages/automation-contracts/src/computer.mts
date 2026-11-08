import type { InvocationScope, JsonValue, TurnScope } from './runtime.mjs'

/** 正式身份是构建/签名配置；不接受模型自报 team 或 selfAllowed。 */
export interface NativeHostIdentity {
  readonly helperId: string
  readonly allowedPeerIds: readonly string[]
  readonly protectedTargetIds: readonly string[]
}

export interface NativeRequestContext {
  readonly scope: InvocationScope
  readonly actionId: string
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

/** Rust、签名宿主或 Node 均可实现请求端口；binary framing 不出现在工具参数里。 */
export interface NativeHelperPort {
  request(method: string, params: JsonValue, context: NativeRequestContext): Promise<JsonValue>
  subscribe(listener: (event: { method: string; params: JsonValue }) => void): () => void
  cancelAction(actionId: string): Promise<void>
  endTurn(scope: TurnScope): Promise<void>
  dispose(): Promise<void>
}

export interface NativeComponent {
  readonly platform: 'darwin' | 'win32'
  readonly path: string
  readonly version: string
  readonly identity: NativeHostIdentity
}

export interface NativeLauncher {
  /** Mac 实现必须保留 LaunchServices/TCC 责任，Windows 实现负责父退出与管道清理。 */
  connect(component: NativeComponent, signal: AbortSignal): Promise<NativeHelperPort>
}

export interface ComputerPermissionPort {
  /** 查询不弹系统授权；未知、待捕获及已拒绝不能合并成 true。 */
  status(): Promise<{
    accessibility: boolean
    screenRecording: boolean
    capture: 'untested' | 'pending' | 'ready' | 'denied' | 'failed' | 'unsupported'
  }>
  /** 只从可信宿主 UI 调用，不由模型自动授予。 */
  openSettings(kind: 'accessibility' | 'screenRecording'): Promise<void>
}
