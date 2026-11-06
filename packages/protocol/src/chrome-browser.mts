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
/** 开发者模式加载用的扩展 ID，由 apps/chrome-extension/identity.json 的公钥算出。 */
export const CHROME_UNPACKED_EXTENSION_ID = 'fakgembkgnmeknpaegnneneockbjhaai'
/**
 * 应用商店分配的扩展 ID。要先在开发者控制台上传一个不公开的草稿才知道，拿到后只改这一处；
 * 为 null 时只认开发者模式加载的扩展，设置页也只给开发者模式这一条路。
 */
export const CHROME_STORE_EXTENSION_ID: string | null = 'ddnllmibgnhhiiaaidfamlknbnfjpnpo'
export const CHROME_STORE_URL: string | null = CHROME_STORE_EXTENSION_ID
  ? `https://chromewebstore.google.com/detail/${CHROME_STORE_EXTENSION_ID}`
  : null
const EXTENSION_ID = /^[a-p]{32}$/
/**
 * 宿主清单 allowed_origins、原生宿主和桌面端都认的扩展 ID。每个 ID 都能驱动代理使用 Chrome，
 * 所以只放随 Litch 发布的两个；以后加用户自编扩展的 ID 只能来自用户在设置里的显式操作（custom）。
 */
export function chromeExtensionIds(custom: readonly string[] = []): string[] {
  const ids = [CHROME_UNPACKED_EXTENSION_ID, CHROME_STORE_EXTENSION_ID, ...custom]
  return [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && EXTENSION_ID.test(id))),
  ]
}

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
  /** 连上来的扩展 ID（允许列表中的一个）。 */
  extensionId: string
  /** 用户在扩展中主动停止，必须由用户手动恢复。 */
  stopped?: boolean
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
  /** 宿主从会话投影取得的标题，只用于 Chrome 分组显示。 */
  sessionTitle?: string
  leaseId: string
  tabId: number
  owner: ChromeLeaseOwner
  origins: string[]
  expiresAt: number
  original: boolean
  keep: boolean
}

export type ChromeErrorCode =
  | 'userStopped'
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
      stopped?: boolean
    }
  | { kind: 'control'; stopped: boolean }
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
  sitePolicy: { trustAll: boolean; blocked: string[] }
  savedSites: Array<{ origin: string; at: number }>
  supported: boolean
  /** 宿主登记方式和支持的浏览器按平台不同；不支持的平台为 null。 */
  platform: 'darwin' | 'win32' | 'linux' | null
  prepared: boolean
  enabled: boolean
  allowedDevices: string[]
  /** 开发者模式加载的扩展 ID。 */
  extensionId: string
  /** 宿主认的全部扩展 ID。 */
  allowedExtensionIds: string[]
  /** 这个 Litch 自带（扩展目录里）的扩展版本，只用于开发者模式加载。 */
  bundledVersion: string
  extensionDirectory: string
  /** 应用商店的扩展页；未上架时为 null。 */
  storeUrl: string | null
  instances: ChromeInstance[]
  lastError: string | null
}

export type ChromeSettingsRequest =
  | { kind: 'chrome.trust'; on: boolean }
  | { kind: 'chrome.block'; site: string }
  | { kind: 'chrome.unblock'; host: string | null }
  | { kind: 'chrome.forget'; origin: string | null }
  | { kind: 'chrome.status' }
  | { kind: 'chrome.prepare' }
  | { kind: 'chrome.extensions' }
  | { kind: 'chrome.store' }
  | { kind: 'chrome.directory' }
  | { kind: 'chrome.enable'; enabled: boolean }
  | { kind: 'chrome.device'; deviceId: string; enabled: boolean }
  | { kind: 'chrome.stop' }
