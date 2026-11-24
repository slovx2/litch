// 飞书来源（litchFeishu 扩展）：设备接的飞书应用、群、私聊绑定、收件箱与发件。
// 时间用 UTC epoch 秒；飞书的 ID（cli_…、oc_…、ou_…、om_…）原样用字符串。秘密只进不出。

export const FEISHU_EXTENSION = 'litchFeishu'

export const FEISHU_METHOD = {
  appList: 'litch/feishu/app/list',
  appGet: 'litch/feishu/app/get',
  appRegisterBegin: 'litch/feishu/app/register/begin',
  appRegisterGet: 'litch/feishu/app/register/get',
  appRegisterCancel: 'litch/feishu/app/register/cancel',
  appConfigure: 'litch/feishu/app/configure',
  appRotate: 'litch/feishu/app/rotate',
  appUpdate: 'litch/feishu/app/update',
  appRemove: 'litch/feishu/app/remove',
  appCheck: 'litch/feishu/app/check',
  appUpgrade: 'litch/feishu/app/upgrade',
} as const

export const FEISHU_NOTIFICATION = {
  appsChanged: 'litch/feishu/appsChanged',
  registrationChanged: 'litch/feishu/registrationChanged',
} as const

/** 只读方法；其余写操作只给设备管理员连接 */
export const FEISHU_PUBLIC_READS: ReadonlySet<string> = new Set([
  FEISHU_METHOD.appList,
  FEISHU_METHOD.appGet,
])

export const FEISHU_APP_ID = /^cli_[0-9a-f]{16}$/
export const FEISHU_BOT_NAME_MAX = 30
export const FEISHU_SECRET_MAX = 256

export type FeishuConnectionState =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

/** 连接失败的原因，界面按代码选文案；不含秘密和飞书原文 */
export type FeishuErrorCode =
  | 'credential_rejected'
  | 'app_disabled'
  | 'network'
  | 'rate_limited'
  | 'platform'
  | 'connection_limit'

export interface FeishuConnection {
  state: FeishuConnectionState
  /** 进入当前状态的时间 */
  since: number
  lastConnectedAt?: number
  lastEventAt?: number
  reconnects: number
  error?: { code: FeishuErrorCode; at: number }
}

export type FeishuCapabilityState =
  | 'ok'
  | 'missing'
  | 'needs_self_manage'
  | 'app_disabled'
  | 'unknown'

export interface FeishuCapability {
  checkedAt: number
  state: FeishuCapabilityState
  missingScopes: string[]
  missingEvents: string[]
  missingCallbacks: string[]
  /** 补申请后提交的版本；审核通过前是 pending_review */
  publish?: { state: 'pending_review' | 'published' | 'unknown'; versionId?: string; at: number }
}

export interface FeishuApp {
  appId: string
  revision: number
  /** 机器人名（飞书上的应用名） */
  name: string
  botOpenId?: string
  avatar?: string
  managerId: string | null
  enabled: boolean
  credential: { generation: number; updatedAt: number }
  connection: FeishuConnection
  capability: FeishuCapability | null
  /** 通过创建向导建的应用：创建者的 open_id，只用来在绑定页标“创建者” */
  creatorOpenId?: string
  createdAt: number
}

export type FeishuRegistrationState =
  | 'waiting'
  | 'succeeded'
  | 'denied'
  | 'expired'
  | 'canceled'
  | 'error'

export interface FeishuRegistration {
  registrationId: string
  revision: number
  state: FeishuRegistrationState
  name: string
  /** 飞书创建页地址，只在 waiting 时有 */
  url?: string
  expiresAt: number
  appId?: string
  error?: 'lark_tenant' | 'unavailable' | 'credential_invalid' | 'already_configured'
}

type Empty = Record<string, never>
type Request<P, R> = { params: P; result: R }

export interface FeishuAppUpdateParams {
  appId: string
  expectedRevision: number
  managerId?: string | null
  enabled?: boolean
}

export interface FeishuRequests {
  [FEISHU_METHOD.appList]: Request<Empty, { apps: FeishuApp[] }>
  [FEISHU_METHOD.appGet]: Request<{ appId: string }, { app: FeishuApp }>
  [FEISHU_METHOD.appRegisterBegin]: Request<
    { operationId: string; name: string },
    { registration: FeishuRegistration }
  >
  [FEISHU_METHOD.appRegisterGet]: Request<
    { registrationId: string },
    { registration: FeishuRegistration }
  >
  [FEISHU_METHOD.appRegisterCancel]: Request<
    { registrationId: string },
    { registration: FeishuRegistration }
  >
  [FEISHU_METHOD.appConfigure]: Request<
    { operationId: string; appId: string; appSecret: string },
    { app: FeishuApp }
  >
  [FEISHU_METHOD.appRotate]: Request<
    { operationId: string; appId: string; appSecret: string; expectedGeneration: number },
    { app: FeishuApp }
  >
  [FEISHU_METHOD.appUpdate]: Request<FeishuAppUpdateParams, { app: FeishuApp }>
  [FEISHU_METHOD.appRemove]: Request<{ appId: string; expectedRevision: number }, Empty>
  [FEISHU_METHOD.appCheck]: Request<{ appId: string }, { app: FeishuApp }>
  [FEISHU_METHOD.appUpgrade]: Request<{ appId: string; operationId: string }, { app: FeishuApp }>
}

export interface FeishuNotifications {
  [FEISHU_NOTIFICATION.appsChanged]: { appId?: string }
  [FEISHU_NOTIFICATION.registrationChanged]: { registrationId: string; revision: number }
}

export type FeishuMethod = keyof FeishuRequests
