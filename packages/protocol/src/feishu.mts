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
  chatBackfill: 'litch/feishu/chat/backfill',
  inboxList: 'litch/feishu/inbox/list',
  inboxGet: 'litch/feishu/inbox/get',
  outboxList: 'litch/feishu/outbox/list',
  outboxCancel: 'litch/feishu/outbox/cancel',
} as const

export const FEISHU_NOTIFICATION = {
  appsChanged: 'litch/feishu/appsChanged',
  registrationChanged: 'litch/feishu/registrationChanged',
  chatsChanged: 'litch/feishu/chatsChanged',
  inboxChanged: 'litch/feishu/inboxChanged',
  outboxChanged: 'litch/feishu/outboxChanged',
} as const

/** 只读方法；其余写操作只给设备管理员连接 */
export const FEISHU_PUBLIC_READS: ReadonlySet<string> = new Set([
  FEISHU_METHOD.appList,
  FEISHU_METHOD.appGet,
  FEISHU_METHOD.chatList,
  FEISHU_METHOD.chatGet,
  FEISHU_METHOD.chatMembers,
  FEISHU_METHOD.inboxList,
  FEISHU_METHOD.inboxGet,
  FEISHU_METHOD.outboxList,
])

export const FEISHU_APP_ID = /^cli_[0-9a-f]{16}$/
export const FEISHU_BOT_NAME_MAX = 30
export const FEISHU_SECRET_MAX = 256
export const FEISHU_CHAT_ID = /^oc_[0-9A-Za-z_-]{1,64}$/
export const FEISHU_OPEN_ID = /^ou_[0-9A-Za-z_-]{1,64}$/
/** 发件的操作 ID：经理给的或设备生成的，拼上分片序号后要放得进飞书 uuid（50 字符） */
export const FEISHU_OPERATION_ID = /^[A-Za-z0-9_-]{8,40}$/
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
  /** 设备上这个群的记录；取消接入但留着记录的群也有（界面标“未接入（有记录）”） */
  records?: FeishuChatRecords
}

/** 补历史：接入时补最近 7 天，或手动补一段；时间是秒 */
export interface FeishuBackfill {
  kind: 'access' | 'manual'
  state: 'running' | 'done' | 'failed'
  start: number
  end: number
  fetched: number
  /** 窗口里超过单次上限，只留了最新的那些 */
  truncated: boolean
  startedAt: number
  finishedAt?: number
}

/** 最近一次补缺口（每次连上都补断线期间的消息）；时间是秒 */
export interface FeishuGapFill {
  at: number
  start: number
  end: number
  fetched: number
  /** false：超过单次上限，这段没补全 */
  complete: boolean
}

export interface FeishuChatRecords {
  messages: number
  /** 最早一条的时间（秒） */
  oldestAt?: number
  backfill?: FeishuBackfill
  gap?: FeishuGapFill
}

/** 收件箱：谁在飞书里找了经理（D-161）。不存正文，正文在设备的消息库里 */
export type FeishuInboxTrigger = 'mention' | 'reply' | 'p2p'
export type FeishuInboxStatus = 'queued' | 'notified' | 'processed'
/** bound：已私聊绑定；member：本群成员；unknown：都不是（设备核过的身份，不信正文里的自称） */
export type FeishuSenderIdentity = 'bound' | 'member' | 'unknown'

export interface FeishuInboxEntry {
  /** FI-<n> */
  inboxId: string
  status: FeishuInboxStatus
  appId: string
  managerId: string
  chatId: string
  chatKind: 'group' | 'p2p'
  messageId: string
  senderOpenId: string
  senderName?: string
  senderIdentity: FeishuSenderIdentity
  trigger: FeishuInboxTrigger
  /** 消息在飞书上的创建时间（秒） */
  createdAt: number
  receivedAt: number
  deliveryId?: string
  notifiedAt?: number
  processedAt?: number
  /** rate_limited：叫醒额度用完，排到下一个窗口 */
  note?: 'rate_limited'
}

/** 收件箱条目对应的消息（从设备的消息库读；过了保留期的只剩 ID） */
export interface FeishuInboxMessage {
  chatName: string
  text: string | null
  msgType: string
  state: 'normal' | 'recalled' | 'deleted'
  purged: boolean
}

/**
 * 发件队列（经理的发言）：awaiting_approval → queued → sending → sent；
 * unknown 是网络中断等发送结果不明，一小时内自动重发（飞书按 uuid 去重），之后停下等人核对
 */
export type FeishuOutboxState =
  | 'awaiting_approval'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'rejected'
  | 'canceled'
  | 'unknown'
/** 发出去的样子：纯文本、富文本（Markdown 段落加 @）、卡片（有代码块或表格时）、图片、文件 */
export type FeishuOutboxFormat = 'text' | 'post' | 'card' | 'image' | 'file'

export interface FeishuOutboxEntry {
  /** 操作 ID，也是发给飞书的 uuid 前缀 */
  operationId: string
  appId: string
  managerId: string
  /** chat：已接入的群；user：已绑定用户的私聊 */
  target: { kind: 'chat' | 'user'; id: string; name: string }
  /** 回复的消息 ID */
  replyTo?: string
  format: FeishuOutboxFormat
  /** 正文开头（最多 200 字）；图片和文件是文件名 */
  summary: string
  /** 分成几条发 */
  parts: number
  /** 已发出的各条的消息 ID */
  messageIds: string[]
  mentions: FeishuPerson[]
  state: FeishuOutboxState
  /** 要审批时的审批 ID（A-n，litchReviews） */
  reviewId?: string
  attempts: number
  /** 没发成的原因代码（failed、rejected、canceled、unknown 时） */
  error?: string
  createdAt: number
  updatedAt: number
  sentAt?: number
}

/** 单次补历史最多补多少条 */
export const FEISHU_BACKFILL_LIMIT = 1000

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
  /** 手动补一段历史（秒）；补的进度在群的 records.backfill 里 */
  [FEISHU_METHOD.chatBackfill]: Request<
    { appId: string; chatId: string; start: number; end: number },
    { chat: FeishuChat }
  >
  /** 经理的收件箱，新的在前；before 是上一页最后一条的 inboxId */
  [FEISHU_METHOD.inboxList]: Request<
    {
      managerId: string
      statuses?: FeishuInboxStatus[]
      before?: string
      limit?: number
    },
    /** messages：按 inboxId 给出对应消息，消息库里没有的不出现 */
    {
      entries: FeishuInboxEntry[]
      messages: Record<string, FeishuInboxMessage>
      next?: string
    }
  >
  [FEISHU_METHOD.inboxGet]: Request<
    { inboxId: string },
    { entry: FeishuInboxEntry; message: FeishuInboxMessage | null }
  >
  /** 应用的发件队列，新的在前；before 是上一页最后一条的 operationId */
  [FEISHU_METHOD.outboxList]: Request<
    { appId: string; states?: FeishuOutboxState[]; before?: string; limit?: number },
    { entries: FeishuOutboxEntry[]; next?: string }
  >
  /** 撤下还没发出的（含待审批的）；已发出的不撤回飞书上的消息 */
  [FEISHU_METHOD.outboxCancel]: Request<
    { appId: string; operationId: string },
    { entry: FeishuOutboxEntry }
  >
}

export interface FeishuNotifications {
  [FEISHU_NOTIFICATION.appsChanged]: { appId?: string }
  [FEISHU_NOTIFICATION.registrationChanged]: { registrationId: string; revision: number }
  [FEISHU_NOTIFICATION.chatsChanged]: { appId: string; chatId?: string }
  [FEISHU_NOTIFICATION.inboxChanged]: { managerId: string; appId: string }
  [FEISHU_NOTIFICATION.outboxChanged]: { appId: string; operationId: string }
}

export type FeishuMethod = keyof FeishuRequests
