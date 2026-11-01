// 控制端 Chrome 的本地桥与界面契约，不是 app-server 扩展；M2 沿既有 clientTools。
/**
 * 扩展与 Litch 之间线协议的兼容规则。扩展由应用商店自动更新、要等审核，不能要求两边版本号相同。
 * - 两边各自声明 [CHROME_WIRE_MIN, CHROME_WIRE_VERSION]：现在说的协议号，和还能跟对方说的最老协议号。
 * - 对方会忽略的增量（新的可选字段、新事件）不升号；新请求、改结果形状或语义要升号，
 *   发送方只用协商出的协议号允许的能力（Litch 看 ChromeInstance.protocol，扩展看 welcome）。
 * - CHROME_WIRE_MIN 最多抬到上一个已发布小版本的 CHROME_WIRE_VERSION，
 *   这样相邻小版本的 Litch 与扩展无论谁新都能协商成功。
 */
export const CHROME_WIRE_VERSION = 1
export const CHROME_WIRE_MIN = 1
export const CHROME_HOST_NAME = 'ai.litch.chrome'
export const CHROME_TAB_PREFIX = 'chrome:'
/** 应用商店的扩展页；上架前为 null，设置页只给开发者模式加载这一条路。 */
export const CHROME_STORE_URL: string | null = null

/** 不兼容时该更新哪一边。 */
export type ChromeIncompatibility = 'extensionOutdated' | 'litchOutdated'
export type ChromeExtensionSource = 'store' | 'unpacked'

/** 按两边声明的范围协商：成功给出双方都会说的最高协议号。 */
export function negotiateChromeWire(
  peer: { protocol: number; minProtocol: number },
  own: { protocol: number; minProtocol: number } = {
    protocol: CHROME_WIRE_VERSION,
    minProtocol: CHROME_WIRE_MIN,
  },
): { protocol: number } | { incompatible: ChromeIncompatibility } {
  if (peer.protocol < own.minProtocol) return { incompatible: 'extensionOutdated' }
  if (peer.minProtocol > own.protocol) return { incompatible: 'litchOutdated' }
  return { protocol: Math.min(peer.protocol, own.protocol) }
}

export interface ChromeInstance {
  id: string
  epoch: string
  version: string
  name: string
  /** 协商出的协议号；不兼容时为 null。 */
  protocol: number | null
  incompatible: ChromeIncompatibility | null
  /** 扩展怎么装的；扩展没报时为 null。 */
  source: ChromeExtensionSource | null
}

export interface ChromeLeaseOwner {
  deviceId: string
  threadId: string
  turnId: string
}

export interface ChromeTabState {
  id: number
  title: string
  url: string
  loading: boolean
  generation: number
  openerTabId?: number
}

export interface ChromeGrant {
  leaseId: string
  tabId: number
  owner: ChromeLeaseOwner
  origins: string[]
  expiresAt: number
  original: boolean
  keep: boolean
}

export type ChromeErrorCode =
  | 'disconnected'
  | 'versionMismatch'
  | 'staleLease'
  | 'staleDocument'
  | 'originNotApproved'
  | 'tabNotClaimed'
  | 'targetUnavailable'
  | 'busy'
  | 'signingIn'
  | 'cancelled'
  | 'invalid'
  | 'failed'

export interface ChromeReply {
  kind: 'result'
  id: string
  result?: unknown
  error?: { code: ChromeErrorCode; message: string }
}

export interface ChromeRequest {
  kind: 'request'
  id: string
  epoch: string
  op:
    | 'list'
    | 'new'
    | 'claim'
    | 'release'
    | 'navigate'
    | 'history'
    | 'show'
    | 'command'
    | 'freeze'
    | 'unfreeze'
    | 'pointer'
    | 'renew'
    | 'stop'
    | 'authorize'
    | 'console'
  leaseId?: string
  generation?: number
  args: Record<string, unknown>
}

/** Litch 收到 hello 后回给扩展：协商结果。不兼容时 protocol 为 null，扩展停在只连接不执行的状态。 */
export interface ChromeWelcome {
  kind: 'welcome'
  protocol: number | null
  incompatible: ChromeIncompatibility | null
  litchVersion: string
}

export type ChromeEvent =
  | {
      kind: 'hello'
      protocol: number
      /** 缺省等于 protocol。 */
      minProtocol?: number
      source?: ChromeExtensionSource
      version: string
      instanceId: string
      epoch: string
      name: string
    }
  | { kind: 'tab'; tab: ChromeTabState }
  | { kind: 'revoked'; leaseId: string; reason: string }
  | { kind: 'removed'; tabId: number }
  | {
      kind: 'dialog'
      tabId: number
      generation: number
      dialog: { type: string; message: string; defaultPrompt: string } | null
    }

export interface ChromeSettingsState {
  supported: boolean
  prepared: boolean
  enabled: boolean
  allowedDevices: string[]
  extensionId: string
  /** 这个 Litch 自带（扩展目录里）的扩展版本，只用于开发者模式加载。 */
  bundledVersion: string
  extensionDirectory: string
  /** 应用商店的扩展页；未上架时为 null。 */
  storeUrl: string | null
  instances: ChromeInstance[]
  lastError: string | null
}

export type ChromeSettingsRequest =
  | { kind: 'chrome.status' }
  | { kind: 'chrome.prepare' }
  | { kind: 'chrome.extensions' }
  | { kind: 'chrome.store' }
  | { kind: 'chrome.directory' }
  | { kind: 'chrome.enable'; enabled: boolean }
  | { kind: 'chrome.device'; deviceId: string; enabled: boolean }
  | { kind: 'chrome.stop' }
