// 飞书来源在客户端的主题与命令。快照保留设备原始时间（UTC 秒）；fetchedAt 是客户端时间（毫秒）。
import {
  FEISHU_METHOD,
  type FeishuApp,
  type FeishuRegistration,
  type FeishuRequests,
} from '../../../protocol/src/feishu.mjs'
import type { ExternalSnapshot } from './external.mjs'

export type FeishuTopic =
  | { kind: 'feishuDevice'; deviceId: string }
  | { kind: 'feishuRegistration'; deviceId: string; registrationId: string }

export interface FeishuDeviceView {
  apps: ExternalSnapshot<FeishuApp[]>
}
export type FeishuRegistrationView = ExternalSnapshot<FeishuRegistration>

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
