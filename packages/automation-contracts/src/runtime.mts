import type { ClientToolNamespaceSpec } from './tool-spec.mjs'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** 只能由可信宿主填入；模型参数不能选择执行电脑、租户、会话或批准身份。 */
export interface InvocationScope {
  readonly hostId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
}

export type TurnScope = Omit<InvocationScope, 'callId'>
export type SessionScope = Omit<TurnScope, 'turnId'>

export interface ToolInvocation {
  readonly scope: InvocationScope
  readonly namespace: string
  readonly tool: string
  readonly arguments: JsonValue
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export interface ToolResult {
  success: boolean
  content: ToolContent[]
  /** 不将实现异常或秘密当作模型可见错误。 */
  error?: { code: string; message: string; mayHaveExecuted: boolean }
}

export type ApprovalSubject =
  | { kind: 'site'; origin: string; url: string; browser: string }
  | { kind: 'browserInstance'; instanceId: string; name: string }
  | { kind: 'browserTab'; tabId: string; origin: string; title: string }
  | { kind: 'computerSelf'; targetId: string }
  | { kind: 'action'; description: string }

export type ApprovalDecision = 'once' | 'session' | 'always' | 'decline'

export interface ApprovalRequest {
  readonly id: string
  readonly nonce: string
  readonly scope: InvocationScope
  readonly subject: ApprovalSubject
  readonly choices: readonly ApprovalDecision[]
  readonly expiresAt: number | null
}

/** 宿主先验证答复来源/签名；执行器再验证绑定关系、过期和取消。 */
export interface ApprovalAnswer {
  readonly requestId: string
  readonly nonce: string
  readonly scope: InvocationScope
  readonly decision: ApprovalDecision
}

export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer | null>
  /** 退出/回合结束时撤销可信 UI 中尚未回答的请求。 */
  dismiss(scope: TurnScope): Promise<void>
}

export interface InvocationContext {
  readonly signal: AbortSignal
  readonly approvals: ApprovalPort
  /** 等人期间暂停宿主工具超时，返回幂等的恢复函数。 */
  hold(): () => void
}

export interface ToolExecutor {
  readonly definitions: readonly ClientToolNamespaceSpec[]
  /** 失败用结构化结果；取消不得重放可能已执行的动作。 */
  execute(call: ToolInvocation, context: InvocationContext): Promise<ToolResult>
  endTurn(scope: TurnScope): Promise<void>
  endSession(scope: SessionScope): Promise<void>
  dispose(): Promise<void>
}

export interface StateStore {
  read(key: string): Promise<{ revision: string; value: JsonValue } | undefined>
  /** 单键原子替换；revision 不符必须失败，undefined 表示要求键尚不存在。 */
  compareAndSet(key: string, revision: string | undefined, value: JsonValue): Promise<string>
}

/** 秘密只在可信后端使用；不通过工具结果、事件或日志暴露。 */
export interface SecretStore {
  available(): Promise<boolean>
  seal(plain: Uint8Array): Promise<Uint8Array>
  open(sealed: Uint8Array): Promise<Uint8Array>
}

export interface AutomationLog {
  write(
    level: 'debug' | 'info' | 'warning' | 'error',
    event: string,
    fields: Record<string, JsonValue>,
  ): void
}

export interface HostEnvironment {
  readonly productName: string
  readonly platform: string
  readonly state: StateStore
  readonly secrets: SecretStore
  readonly log: AutomationLog
  now(): number
  randomId(): string
}

export interface FileAccess {
  /** 受信任后端验证路径/来源，返回驱动可使用但模型不可伪造的句柄。 */
  authorizeUpload(
    paths: readonly string[],
    scope: InvocationScope,
    signal: AbortSignal,
  ): Promise<readonly string[]>
}

export interface ResolvedUrl {
  readonly requested: string
  readonly effective: string
  release(): Promise<void>
}

export interface UrlResolver {
  resolve(url: string, scope: InvocationScope, signal: AbortSignal): Promise<ResolvedUrl>
}
