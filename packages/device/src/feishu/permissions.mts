// 飞书应用要申请的权限、订阅的事件和回调：创建向导、能力自检、补申请和界面都用这一份。
// 改这里要同时改产品手册的权限表。
import { gzipSync } from 'node:zlib'
import { FEISHU_USER_SCOPES } from './user-oauth.mjs'

export const FEISHU_SCOPES = [
  // 收消息、读历史、撤回事件
  'im:message.group_msg',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:message:readonly',
  // 发言、回复、更新审批卡片
  'im:message:send_as_bot',
  // 上传图片文件、下载附件
  'im:resource',
  // 列群、群信息、成员、机器人进退群事件
  'im:chat:read',
  'im:chat.members:read',
  'im:chat.members:bot_access',
  // 显示名字
  'contact:user.base:readonly',
  // 能力自检与补申请
  'application:application:self_manage',
  'application:application:patch',
  // 给经理经飞书 CLI 调用的其他接口
  'docx:document',
  'drive:drive',
  'sheets:spreadsheet',
  'bitable:app',
  'wiki:wiki',
  'calendar:calendar',
  'task:task',
] as const

export const FEISHU_EVENTS = [
  'im.message.receive_v1',
  'im.message.recalled_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'im.chat.member.user.added_v1',
  'im.chat.member.user.deleted_v1',
  'im.chat.member.user.withdrawn_v1',
  'im.chat.updated_v1',
  'im.chat.disbanded_v1',
] as const

export const FEISHU_CALLBACKS = ['card.action.trigger'] as const

export const SELF_MANAGE_SCOPE = 'application:application:self_manage'
export const PATCH_SCOPE = 'application:application:patch'

/** 创建向导的 addons 参数：清单 JSON 经 gzip 后 base64url，去掉末尾的 = */
export function registrationAddons(): string {
  const manifest = {
    scopes: { tenant: [...FEISHU_SCOPES] },
    events: { items: { tenant: [...FEISHU_EVENTS] } },
    callbacks: { items: [...FEISHU_CALLBACKS] },
    preset: false,
  }
  const packed = gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8'), { level: 9 })
  // gzip 头里有时间戳，置零让同一份清单编出同一个参数
  packed.writeUInt32LE(0, 4)
  return packed.toString('base64url')
}

export interface CapabilityDiff {
  missingScopes: string[]
  missingEvents: string[]
  missingCallbacks: string[]
  /** 用户身份要的权限（D-183）里还没开的 */
  missingUserScopes: string[]
  /** 没开“刷新 user_access_token”（应用信息的 allow_refresh_token） */
  refreshTokenDisabled: boolean
}

export function diffCapability(have: {
  scopes: ReadonlySet<string>
  userScopes: ReadonlySet<string>
  events: ReadonlySet<string>
  callbacks: ReadonlySet<string>
  allowRefreshToken: boolean
}): CapabilityDiff {
  return {
    missingScopes: FEISHU_SCOPES.filter((scope) => !have.scopes.has(scope)),
    missingEvents: FEISHU_EVENTS.filter((event) => !have.events.has(event)),
    missingCallbacks: FEISHU_CALLBACKS.filter((callback) => !have.callbacks.has(callback)),
    missingUserScopes: FEISHU_USER_SCOPES.filter((scope) => !have.userScopes.has(scope)),
    refreshTokenDisabled: !have.allowRefreshToken,
  }
}
