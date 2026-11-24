// 飞书来源在客户端的主题与命令。快照保留设备原始时间（UTC 秒）；fetchedAt 是客户端时间（毫秒）。
import {
  FEISHU_METHOD,
  type FeishuApp,
  type FeishuChat,
  type FeishuRegistration,
  type FeishuRequests,
} from '../../../protocol/src/feishu.mjs'
import type { ExternalSnapshot } from './external.mjs'

export type FeishuTopic =
  | { kind: 'feishuDevice'; deviceId: string }
  | { kind: 'feishuRegistration'; deviceId: string; registrationId: string }
  | { kind: 'feishuChats'; deviceId: string; appId: string }

export interface FeishuDeviceView {
  apps: ExternalSnapshot<FeishuApp[]>
  /** 这条连接能不能做写操作；还没读到时是 null */
  admin: boolean | null
}
export type FeishuRegistrationView = ExternalSnapshot<FeishuRegistration>
/** 机器人所在的群（含机器人已不在、但还留着接入设置的群）；syncedAt 是设备最近回源的时间（UTC 秒） */
export type FeishuChatsView = ExternalSnapshot<{ chats: FeishuChat[]; syncedAt: number | null }>

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
} as const

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
