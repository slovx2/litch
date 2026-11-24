// 飞书来源在客户端的主题与命令。快照保留设备原始时间（UTC 秒）；fetchedAt 是客户端时间（毫秒）。
import {
  FEISHU_METHOD,
  type FeishuApp,
  type FeishuBinding,
  type FeishuChat,
  type FeishuInboxEntry,
  type FeishuInboxMessage,
  type FeishuOutboxEntry,
  type FeishuRegistration,
  type FeishuRequests,
  type FeishuUserGrant,
} from '../../../protocol/src/feishu.mjs'
import {
  REVIEWS_METHOD,
  type Review,
  type ReviewsRequests,
} from '../../../protocol/src/reviews.mjs'
import type { ExternalSnapshot } from './external.mjs'

export type FeishuTopic =
  | { kind: 'feishuDevice'; deviceId: string }
  | { kind: 'feishuRegistration'; deviceId: string; registrationId: string }
  | { kind: 'feishuChats'; deviceId: string; appId: string }
  | { kind: 'feishuInbox'; deviceId: string; managerId: string }
  | { kind: 'feishuOutbox'; deviceId: string; appId: string }
  | { kind: 'feishuBindings'; deviceId: string; appId: string }
  /** 审批（litchReviews）：给 managerId 只看这位经理发起的 */
  | { kind: 'reviews'; deviceId: string; managerId?: string }

export interface FeishuDeviceView {
  apps: ExternalSnapshot<FeishuApp[]>
  /** 这条连接能不能做写操作；还没读到时是 null */
  admin: boolean | null
}
export type FeishuRegistrationView = ExternalSnapshot<FeishuRegistration>
/** 机器人所在的群（含机器人已不在、但还留着接入设置的群）；syncedAt 是设备最近回源的时间（UTC 秒） */
export type FeishuChatsView = ExternalSnapshot<{ chats: FeishuChat[]; syncedAt: number | null }>

/** 经理的飞书收件箱：最近的一页（新的在前）加对应的消息 */
export type FeishuInboxView = ExternalSnapshot<{
  entries: FeishuInboxEntry[]
  messages: Record<string, FeishuInboxMessage>
  next?: string
}>

/** 应用的发件队列：最近的一页（新的在前） */
export type FeishuOutboxView = ExternalSnapshot<{ entries: FeishuOutboxEntry[]; next?: string }>

/** 应用的私聊绑定（已绑定和撤销过的，新绑定的在前），连同各人的用户身份授权 */
export type FeishuBindingsView = ExternalSnapshot<{
  bindings: FeishuBinding[]
  grants: FeishuUserGrant[]
}>

/**
 * 审批：待批的全部（最多 200 条）在前，再接最近有了结果的；pending 是待批条数。
 * available=false 是设备不支持审批（没有 litchReviews），界面不出审批入口
 */
export type ReviewsView = ExternalSnapshot<{ reviews: Review[]; pending: number }>

export const FEISHU_COMMAND = {
  'feishu.app.get': FEISHU_METHOD.appGet,
  'feishu.app.register.begin': FEISHU_METHOD.appRegisterBegin,
  'feishu.app.register.get': FEISHU_METHOD.appRegisterGet,
  'feishu.app.register.cancel': FEISHU_METHOD.appRegisterCancel,
  'feishu.app.configure': FEISHU_METHOD.appConfigure,
  'feishu.app.rotate': FEISHU_METHOD.appRotate,
  'feishu.app.update': FEISHU_METHOD.appUpdate,
  'feishu.app.remove': FEISHU_METHOD.appRemove,
  'feishu.app.check': FEISHU_METHOD.appCheck,
  'feishu.app.upgrade': FEISHU_METHOD.appUpgrade,
  'feishu.chat.list': FEISHU_METHOD.chatList,
  'feishu.chat.get': FEISHU_METHOD.chatGet,
  'feishu.chat.members': FEISHU_METHOD.chatMembers,
  'feishu.chat.access': FEISHU_METHOD.chatAccess,
  'feishu.chat.update': FEISHU_METHOD.chatUpdate,
  'feishu.chat.unaccess': FEISHU_METHOD.chatUnaccess,
  'feishu.chat.backfill': FEISHU_METHOD.chatBackfill,
  'feishu.inbox.list': FEISHU_METHOD.inboxList,
  'feishu.inbox.get': FEISHU_METHOD.inboxGet,
  'feishu.outbox.list': FEISHU_METHOD.outboxList,
  'feishu.outbox.cancel': FEISHU_METHOD.outboxCancel,
  'feishu.binding.list': FEISHU_METHOD.bindingList,
  'feishu.binding.lookup': FEISHU_METHOD.bindingLookup,
  'feishu.binding.approve': FEISHU_METHOD.bindingApprove,
  'feishu.binding.revoke': FEISHU_METHOD.bindingRevoke,
  'feishu.binding.update': FEISHU_METHOD.bindingUpdate,
  'feishu.grant.list': FEISHU_METHOD.grantList,
  'feishu.grant.invite': FEISHU_METHOD.grantInvite,
  'feishu.grant.revoke': FEISHU_METHOD.grantRevoke,
} as const

export const REVIEWS_COMMAND = {
  'reviews.list': REVIEWS_METHOD.list,
  'reviews.get': REVIEWS_METHOD.get,
  'reviews.decide': REVIEWS_METHOD.decide,
} as const

export type ReviewsCommandName = keyof typeof REVIEWS_COMMAND
export type ReviewsCommands = {
  [M in ReviewsCommandName]: {
    params: ReviewsRequests[(typeof REVIEWS_COMMAND)[M]]['params'] & { deviceId: string }
    result: ReviewsRequests[(typeof REVIEWS_COMMAND)[M]]['result']
  }
}

export function isReviewsCommand(name: string): name is ReviewsCommandName {
  return Object.hasOwn(REVIEWS_COMMAND, name)
}

export type FeishuCommandName = keyof typeof FEISHU_COMMAND
export type FeishuCommands = {
  [M in FeishuCommandName]: {
    params: FeishuRequests[(typeof FEISHU_COMMAND)[M]]['params'] & { deviceId: string }
    result: FeishuRequests[(typeof FEISHU_COMMAND)[M]]['result']
  }
}

export function isFeishuCommand(name: string): name is FeishuCommandName {
  return Object.hasOwn(FEISHU_COMMAND, name)
}
