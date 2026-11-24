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
  chatList: 'litch/feishu/chat/list',
  chatGet: 'litch/feishu/chat/get',
  chatMembers: 'litch/feishu/chat/members',
  chatAccess: 'litch/feishu/chat/access',
  chatUpdate: 'litch/feishu/chat/update',
  chatUnaccess: 'litch/feishu/chat/unaccess',
} as const

export const FEISHU_NOTIFICATION = {
  appsChanged: 'litch/feishu/appsChanged',
  registrationChanged: 'litch/feishu/registrationChanged',
  chatsChanged: 'litch/feishu/chatsChanged',
} as const

/** 只读方法；其余写操作只给设备管理员连接 */
export const FEISHU_PUBLIC_READS: ReadonlySet<string> = new Set([
  FEISHU_METHOD.appList,
  FEISHU_METHOD.appGet,
  FEISHU_METHOD.chatList,
  FEISHU_METHOD.chatGet,
  FEISHU_METHOD.chatMembers,
])

export const FEISHU_APP_ID = /^cli_[0-9a-f]{16}$/
export const FEISHU_BOT_NAME_MAX = 30
export const FEISHU_SECRET_MAX = 256
export const FEISHU_CHAT_ID = /^oc_[0-9A-Za-z_-]{1,64}$/
export const FEISHU_OPEN_ID = /^ou_[0-9A-Za-z_-]{1,64}$/
/** 群记录的保留天数（D-164） */
export const FEISHU_RETENTION_DAYS = { min: 1, max: 3650, default: 90 } as const
/** 审批过期小时数（D-175） */
export const FEISHU_REVIEW_TTL_HOURS = { min: 1, max: 168, default: 24 } as const
/** 每群手选的叫醒成员上限 */
export const FEISHU_WAKERS_MAX = 200

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

export type FeishuSpeechMode = 'free' | 'approval'

export interface FeishuPerson {
  openId: string
  name: string
}

/** 接入设置；没接入的群是 null */
export interface FeishuChatAccess {
  speech: FeishuSpeechMode
  /** 叫醒名单是否包括本应用全部已绑定用户（D-161） */
  wakeBound: boolean
  /** 手选的叫醒成员（名字是选的时候的快照） */
  wakers: FeishuPerson[]
  retentionDays: number
  reviewTtlHours: number
  accessAt: number
}

export interface FeishuChat {
  appId: string
  chatId: string
  revision: number
  name: string
  avatar?: string
  /** 外部群：群里有组织外的人（D-172） */
  external: boolean
  status: 'normal' | 'dissolved'
  /** 机器人当前在不在群里；移出后接入设置保留（D-178） */
  botPresent: boolean
  access: FeishuChatAccess | null
  updatedAt: number
}

/** 群成员（成员选择器用）；判断是否组织外的人要另申请企业信息权限，不做 */
export type FeishuMember = FeishuPerson

export interface FeishuChatAccessParams {
  appId: string
  chatId: string
  expectedRevision: number
  speech: FeishuSpeechMode
  /** 外部群必须带 true（二次确认） */
  confirmExternal?: boolean
  wakeBound: boolean
  wakers: string[]
  retentionDays: number
  reviewTtlHours: number
}

export interface FeishuChatUpdateParams {
  appId: string
  chatId: string
  expectedRevision: number
  speech?: FeishuSpeechMode
  wakeBound?: boolean
  wakers?: string[]
  retentionDays?: number
  reviewTtlHours?: number
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
  /** admin：这条连接能不能做写操作 */
  [FEISHU_METHOD.appList]: Request<Empty, { apps: FeishuApp[]; admin?: boolean }>
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
  /** 机器人所在的群，加上机器人已不在但还留着接入设置的群；refresh 时先回源 */
  [FEISHU_METHOD.chatList]: Request<
    { appId: string; refresh?: boolean },
    { chats: FeishuChat[]; syncedAt: number | null }
  >
  [FEISHU_METHOD.chatGet]: Request<{ appId: string; chatId: string }, { chat: FeishuChat }>
  [FEISHU_METHOD.chatMembers]: Request<
    { appId: string; chatId: string; refresh?: boolean },
    { members: FeishuMember[]; fetchedAt: number }
  >
  [FEISHU_METHOD.chatAccess]: Request<FeishuChatAccessParams, { chat: FeishuChat }>
  [FEISHU_METHOD.chatUpdate]: Request<FeishuChatUpdateParams, { chat: FeishuChat }>
  /** deleteRecords：同时删这个群的消息记录（D-164，默认由客户端勾上） */
  [FEISHU_METHOD.chatUnaccess]: Request<
    { appId: string; chatId: string; expectedRevision: number; deleteRecords: boolean },
    { chat: FeishuChat }
  >
}

export interface FeishuNotifications {
  [FEISHU_NOTIFICATION.appsChanged]: { appId?: string }
  [FEISHU_NOTIFICATION.registrationChanged]: { registrationId: string; revision: number }
  [FEISHU_NOTIFICATION.chatsChanged]: { appId: string; chatId?: string }
}

export type FeishuMethod = keyof FeishuRequests
