// 控制端 Chrome 的本地桥与界面契约，不是 app-server 扩展；M2 沿既有 clientTools。
export const CHROME_WIRE_VERSION = 1
export const CHROME_HOST_NAME = 'ai.litch.chrome'
export const CHROME_TAB_PREFIX = 'chrome:'

export interface ChromeInstance {
  id: string
  epoch: string
  version: string
  name: string
  compatible: boolean
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

export type ChromeEvent =
  | {
      kind: 'hello'
      protocol: number
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
  expectedVersion: string
  extensionDirectory: string
  instances: ChromeInstance[]
  lastError: string | null
}

export type ChromeSettingsRequest =
  | { kind: 'chrome.status' }
  | { kind: 'chrome.prepare' }
  | { kind: 'chrome.extensions' }
  | { kind: 'chrome.directory' }
  | { kind: 'chrome.enable'; enabled: boolean }
  | { kind: 'chrome.device'; deviceId: string; enabled: boolean }
  | { kind: 'chrome.stop' }
