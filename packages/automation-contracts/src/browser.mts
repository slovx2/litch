import type { InvocationScope, JsonValue, SessionScope } from './runtime.mjs'

/** 所有输入都绑定观察时的文档/布局版本；引用的内部形式由驱动决定。 */
export interface BrowserObservation {
  readonly pageId: string
  readonly generation: string
  readonly geometryRevision: string
}

export type BrowserTarget =
  | { kind: 'element'; ref: string }
  | { kind: 'point'; x: number; y: number }

export type BrowserAction =
  | { kind: 'click'; target: BrowserTarget; button: 'left' | 'right' | 'middle'; count: number }
  | { kind: 'type'; target: BrowserTarget | null; text: string; clear: boolean; submit: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; target: BrowserTarget | null; dx: number; dy: number }
  | { kind: 'upload'; ref: string; fileHandles: readonly string[] }
  | { kind: 'dialog'; accept: boolean; text?: string }

export interface BrowserSnapshot {
  readonly observation: BrowserObservation
  readonly text: string
  readonly truncated: boolean
}

export interface BrowserImage {
  readonly observation: BrowserObservation
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly data: string
  readonly width: number
  readonly height: number
}

export interface BrowserPageInfo {
  readonly id: string
  readonly owner: SessionScope
  readonly kind: 'agent' | 'user'
  readonly url: string
  readonly title: string
  readonly loading: boolean
}

export interface BrowserCapabilities {
  readonly snapshot: boolean
  readonly screenshot: boolean
  readonly trustedInput: boolean
  readonly evaluate: boolean
  readonly upload: boolean
  readonly console: boolean
  readonly dialogs: boolean
  readonly manualSignIn: boolean
  readonly credentialFill: boolean
}

export interface BrowserOperation {
  readonly scope: InvocationScope
  readonly signal: AbortSignal
}

export type NavigationResult = { ok: true } | { ok: false; reason: string }

export type BrowserEvent =
  | { kind: 'changed'; page: BrowserPageInfo }
  | { kind: 'closed'; pageId: string }
  | {
      kind: 'invalidated'
      pageId: string
      reason: 'navigation' | 'resize' | 'disconnect' | 'handover'
    }
  | { kind: 'notice'; pageId: string; message: string }

/** 语义驱动。这里没有 CDP method、Electron 类型或 WKWebView 假实现。 */
export interface BrowserDriver {
  readonly capabilities: BrowserCapabilities
  /** 冻结期间只发脱敏占位状态，不发页面/控制台/截图内容。 */
  pages(): readonly BrowserPageInfo[]
  subscribe(listener: (event: BrowserEvent) => void): () => void
  open(
    owner: SessionScope,
    options: { kind: 'agent' | 'user'; keep: boolean },
    operation: BrowserOperation,
  ): Promise<string>
  close(pageId: string, operation: BrowserOperation): Promise<void>
  setKeep(pageId: string, keep: boolean, operation: BrowserOperation): Promise<void>
  release(pageId: string, operation: BrowserOperation): Promise<void>
  navigate(
    pageId: string,
    url: string,
    timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<NavigationResult>
  history(
    pageId: string,
    action: 'back' | 'forward' | 'reload',
    timeoutMs: number,
    operation: BrowserOperation,
  ): Promise<NavigationResult>
  snapshot(pageId: string, diff: boolean, operation: BrowserOperation): Promise<BrowserSnapshot>
  screenshot(
    pageId: string,
    format: 'png' | 'jpeg',
    operation: BrowserOperation,
  ): Promise<BrowserImage>
  act(
    observation: BrowserObservation,
    action: BrowserAction,
    operation: BrowserOperation,
  ): Promise<void>
  evaluate(
    observation: BrowserObservation,
    expression: string,
    operation: BrowserOperation,
  ): Promise<JsonValue>
  console(
    pageId: string,
    options: { level: 'all' | 'error' | 'warning'; limit: number; clear: boolean },
    operation: BrowserOperation,
  ): Promise<readonly JsonValue[]>
  wait(
    pageId: string,
    condition: { kind: 'load' | 'selector' | 'text' | 'time'; value?: string; timeoutMs: number },
    operation: BrowserOperation,
  ): Promise<boolean>
  /** 页面自发跳转也经过来源门禁；未授权来源拒绝，不能等待模型补一个参数放行。 */
  setNavigationGate(gate: (page: BrowserPageInfo, url: string) => boolean): void
  /** 登录交接期间所有观察/输入/控制台/预览通路一同封锁。 */
  freeze(pageId: string, operation: BrowserOperation): Promise<string>
  /** 只接收可信登录端口返回的交接令牌；解冻后旧 observation 作废。 */
  unfreeze(pageId: string, handoverToken: string, operation: BrowserOperation): Promise<void>
  /** 更新/退出前等待存储落盘；失败上报宿主，不在包里决定退出或无限重试。 */
  flushStorage(signal: AbortSignal): Promise<void>
  endSession(owner: SessionScope): Promise<void>
  dispose(): Promise<void>
}

export interface BrowserPresentation {
  show(pageId: string, owner: SessionScope): Promise<void>
  bounds(pageId: string, rect: { x: number; y: number; width: number; height: number } | null): void
}

export interface SignInPort {
  /** 账户/密码只由可信 UI 和后端处理；返回值不得含用户名、密码或可调用的授权。 */
  request(
    input: {
      pageId: string
      expectedOrigin: string
      reason: string
      hints?: { usernameRef?: string; passwordRef?: string; submitRef?: string }
    },
    operation: BrowserOperation,
  ): Promise<
    | { status: 'completed'; cleanup: 'cleared' | 'reloaded' }
    | { status: 'declined' | 'cancelled' | 'unsupported' | 'failed'; reason: string }
  >
}
