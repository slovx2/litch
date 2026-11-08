import type { JsonValue } from './runtime.mjs'

/** 使用方配置；不能由模型填写，导入库本身不得自动登记/连接。 */
export interface ChromeHostIdentity {
  readonly hostName: string
  readonly extensionIds: readonly string[]
  readonly productName: string
}

export interface NativeHostRegistration {
  readonly hostName: string
  readonly executable: string
  readonly extensionIds: readonly string[]
  /** 安装后持久保存的归属标识；不是认证 token。 */
  readonly ownerId: string
}

export interface RegistrationState {
  readonly registration: NativeHostRegistration | null
  /** 平台登记的快照标识，写入/卸载时做 compare-and-set，避免批准期间换了宿主。 */
  readonly revision: string
}

export interface RegistrationPlan {
  readonly expectedRevision: string
  readonly desired: NativeHostRegistration
}

/** 库不选择独占、接管或共享 broker；宿主提供策略及可信交互。 */
export interface RegistrationPolicy {
  decide(
    current: RegistrationState,
    desired: NativeHostRegistration,
    signal: AbortSignal,
  ): Promise<{ decision: 'deny'; reason: string } | { decision: 'apply'; plan: RegistrationPlan }>
}

export interface RegistrationStore {
  inspect(hostName: string): Promise<RegistrationState>
  /** 必须原子核对 revision/owner，变更冲突不能覆盖；卸载只移除自己仍拥有的登记。 */
  apply(plan: RegistrationPlan, signal: AbortSignal): Promise<RegistrationState>
  remove(hostName: string, ownerId: string, expectedRevision: string): Promise<boolean>
}

/** 传输可为 Native Messaging 或宿主的已认证桥，不推定各自的帧编码相同。 */
export interface ChromeMessageTransport {
  send(message: JsonValue): Promise<void>
  subscribe(listener: (message: JsonValue) => void, disconnected: () => void): () => void
  close(): Promise<void>
}

/** 具体 Chrome API adapter 在扩展包实现；这里只冻结生命周期/身份与资源归属。 */
export interface ExtensionRuntime {
  start(): Promise<void>
  /** stop 撤全部租约/输入/事件监听，不能影响别的扩展或宿主注册的监听器。 */
  stop(): Promise<void>
}

export function validateChromeIdentity(identity: ChromeHostIdentity): void {
  if (
    !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(identity.hostName) ||
    identity.extensionIds.length === 0 ||
    new Set(identity.extensionIds).size !== identity.extensionIds.length ||
    identity.extensionIds.some((id) => !/^[a-p]{32}$/.test(id)) ||
    !identity.productName.trim()
  ) {
    throw new Error('Chrome 宿主身份配置无效')
  }
}
