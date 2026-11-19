// Linux 设备 Chrome 的管理和审批，只发给声明 remoteChrome 的连接。
export const REMOTE_CHROME_PENDING_PREFIX = 'client:remote-chrome:'
export const REMOTE_CHROME_PREFIX = 'litch/remoteChrome/'
export const REMOTE_CHROME_STATUS = `${REMOTE_CHROME_PREFIX}status`
export const REMOTE_CHROME_CONFIGURE = `${REMOTE_CHROME_PREFIX}configure`
export const REMOTE_CHROME_CHANGED = `${REMOTE_CHROME_PREFIX}changed`
export const REMOTE_CHROME_CARDS = `${REMOTE_CHROME_PREFIX}cardsChanged`
export const REMOTE_CHROME_APPROVAL = `${REMOTE_CHROME_PREFIX}approval`

export type RemoteChromeCondition =
  | 'unprepared'
  | 'conflict'
  | 'waiting'
  | 'connected'
  | 'stopped'
  | 'incompatible'
  | 'error'

export interface RemoteChromeStatus {
  condition: RemoteChromeCondition
  enabled: boolean
  hostLabel: string
  storeUrl: string | null
  prepareCommand: string
  enableCommand: string
  disableCommand: string
}

export interface RemoteChromePrompt {
  id: string
  nonce: string
  expiresAt: number
  threadId: string
  turnId: string
  callId: string
  hostLabel: string
  kind: 'site' | 'signIn'
  origin: string
  reason?: string
}

export type RemoteChromeDecision = 'once' | 'session' | 'always' | 'decline'

export interface RemoteChromeAnswer {
  id: string
  nonce: string
  decision: RemoteChromeDecision
}

export type RemoteChromePolicyChange =
  | { action: 'sites' | 'trust-on' | 'trust-off' }
  | { action: 'block' | 'unblock' | 'forget'; site: string }

export interface RemoteChromePolicy {
  trustAll: boolean
  blocked: string[]
  saved: { origin: string; at: number }[]
}
