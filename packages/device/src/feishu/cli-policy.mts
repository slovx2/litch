// 飞书 CLI 代理的放行规则（D-171、D-180）：设备代理收到 lark-cli 的请求后，先规范化路径，再按这里分三类：
// - 拒绝：鉴权、令牌、长连接事件这些接口（防止换出令牌或另开长连接和设备抢事件），以及路径里带可疑写法的；
// - 发言：真正对外“说话”的接口（发、回复、编辑、更新卡片、转发、加急、群公告…），交给发言权限管理器；
// - 其余：放行并记审计（表情回应、撤回、置顶、群管理、文档、任务、日程等，D-180 不按类开关）。
// 名单是按固定版本的 lark-cli 和飞书开放平台的接口整理的；升级 CLI 时要对照它的接口目录重看一遍。

export type CliRoute =
  | { kind: 'reject'; reason: 'auth' | 'path' | 'method' }
  | { kind: 'speech'; speech: CliSpeech }
  | { kind: 'pass' }

/** 发言类请求：怎么认出发给谁 */
export type CliSpeech =
  /** 新发一条：目标在 receive_id_type / receive_id 里 */
  | { type: 'send' }
  /** 针对已有的一条消息（回复、编辑、更新、转发、加急）：目标是这条消息所在的会话 */
  | { type: 'message'; messageId: string; action: string }
  /** 群级的（群公告）：目标是路径里的群 */
  | { type: 'chat'; chatId: string; action: string }
  /** 认不出目标的发言接口（批量发、旧版接口、合并转发等）：一律按最严处理 */
  | { type: 'opaque'; action: string }

const PREFIX = '/open-apis/'

/** 规范化路径：只接受干净的绝对路径，不解码第二次；可疑写法返回 null */
export function normalizePath(raw: string): string | null {
  if (!raw.startsWith('/')) return null
  // 编码过的斜杠、反斜杠、点段、分号参数、空段都不接受（防止匹配和真正请求的路径不一致）
  if (/%2f|%5c|%2e|\\|;|\/\/|(^|\/)\.\.?(\/|$)/i.test(raw)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null
  return decoded.length > 1 && decoded.endsWith('/') ? decoded.slice(0, -1) : decoded
}

/** 一律拒绝的前缀：令牌、授权、长连接、用户登录 */
const REJECTED = [
  '/open-apis/auth/',
  '/open-apis/authen/v1/oidc/',
  '/open-apis/authen/v1/access_token',
  '/open-apis/authen/v1/refresh_access_token',
  '/open-apis/authen/v2/',
  '/oauth/',
  '/callback/ws/endpoint',
  '/open-apis/callback/',
]

const ID = '([A-Za-z0-9_-]{1,128})'

/** 发言类：方法 + 路径（不含 /open-apis/ 前缀） */
const SPEECH: { method: string; path: RegExp; speech: (match: RegExpExecArray) => CliSpeech }[] =
  [
    { method: 'POST', path: /^im\/v1\/messages$/, speech: () => ({ type: 'send' }) },
    {
      method: 'POST',
      path: new RegExp(`^im/v1/messages/${ID}/reply$`),
      speech: (m) => ({ type: 'message', messageId: m[1] as string, action: 'reply' }),
    },
    {
      method: 'PUT',
      path: new RegExp(`^im/v1/messages/${ID}$`),
      speech: (m) => ({ type: 'message', messageId: m[1] as string, action: 'edit' }),
    },
    {
      method: 'PATCH',
      path: new RegExp(`^im/v1/messages/${ID}$`),
      speech: (m) => ({ type: 'message', messageId: m[1] as string, action: 'update' }),
    },
    {
      method: 'POST',
      path: new RegExp(`^im/v1/messages/${ID}/forward$`),
      speech: (m) => ({ type: 'message', messageId: m[1] as string, action: 'forward' }),
    },
    {
      method: 'PATCH',
      path: new RegExp(`^im/v1/messages/${ID}/urgent_(app|sms|phone)$`),
      speech: (m) => ({ type: 'message', messageId: m[1] as string, action: 'urgent' }),
    },
    {
      method: 'POST',
      path: /^im\/v1\/messages\/merge_forward$/,
      speech: () => ({ type: 'opaque', action: 'merge_forward' }),
    },
    {
      method: 'POST',
      path: new RegExp(`^im/v1/threads/${ID}/forward$`),
      speech: () => ({ type: 'opaque', action: 'thread_forward' }),
    },
    {
      method: 'PATCH',
      path: new RegExp(`^im/v1/chats/${ID}/announcement$`),
      speech: (m) => ({ type: 'chat', chatId: m[1] as string, action: 'announcement' }),
    },
    {
      method: '*',
      path: new RegExp(`^docx/v1/chats/${ID}/announcement(/.*)?$`),
      speech: (m) => ({ type: 'chat', chatId: m[1] as string, action: 'announcement' }),
    },
    { method: 'POST', path: /^message\/v4\/(batch_)?send$/, speech: () => ({ type: 'opaque', action: 'legacy_send' }) },
    { method: 'POST', path: /^ephemeral\/v1\/send$/, speech: () => ({ type: 'opaque', action: 'ephemeral' }) },
    {
      method: 'POST',
      path: /^interactive\/v1\/card\/update$/,
      speech: () => ({ type: 'opaque', action: 'card_update' }),
    },
    // 卡片实体：只改已发出卡片内容的（全量更新、改元素、改设置）算发言；单纯新建实体不算
    {
      method: 'PUT',
      path: new RegExp(`^cardkit/v1/cards/${ID}(/.*)?$`),
      speech: () => ({ type: 'opaque', action: 'card_entity' }),
    },
    {
      method: 'PATCH',
      path: new RegExp(`^cardkit/v1/cards/${ID}(/.*)?$`),
      speech: () => ({ type: 'opaque', action: 'card_entity' }),
    },
    {
      method: 'POST',
      path: new RegExp(`^cardkit/v1/cards/${ID}/.+$`),
      speech: () => ({ type: 'opaque', action: 'card_entity' }),
    },
    {
      method: '*',
      path: /^im\/v2\/(app_feed_card|feed_cards)(\/.*)?$/,
      speech: () => ({ type: 'opaque', action: 'feed_card' }),
    },
    {
      method: 'POST',
      path: new RegExp(`^mail/v1/user_mailboxes/${ID}/drafts/${ID}/send$`),
      speech: () => ({ type: 'opaque', action: 'mail_send' }),
    },
    {
      method: 'POST',
      path: /^mail\/v1\/user_mailboxes\/[A-Za-z0-9_@.-]{1,256}\/messages\/send$/,
      speech: () => ({ type: 'opaque', action: 'mail_send' }),
    },
    {
      method: 'POST',
      path: /^approval\/v4\/instances\/remind$/,
      speech: () => ({ type: 'opaque', action: 'approval_remind' }),
    },
  ]

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** 按方法和规范化后的路径分类（路径不含查询） */
export function routeCliRequest(method: string, rawPath: string): CliRoute {
  const upper = method.toUpperCase()
  if (!METHODS.has(upper)) return { kind: 'reject', reason: 'method' }
  const path = normalizePath(rawPath)
  if (path === null) return { kind: 'reject', reason: 'path' }
  const lower = path.toLowerCase()
  if (REJECTED.some((prefix) => lower === prefix.replace(/\/$/, '') || lower.startsWith(prefix)))
    return { kind: 'reject', reason: 'auth' }
  if (!lower.startsWith(PREFIX)) return { kind: 'reject', reason: 'path' }
  const rest = path.slice(PREFIX.length)
  for (const rule of SPEECH) {
    if (rule.method !== '*' && rule.method !== upper) continue
    if (rule.method === '*' && upper === 'GET') continue
    const match = rule.path.exec(rest)
    if (match) return { kind: 'speech', speech: rule.speech(match) }
  }
  return { kind: 'pass' }
}

/** 审计里的路径：ID 一类的段打码（om_、oc_、ou_ 等和长的随机段） */
export function auditPath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      /^(om|oc|ou|on|cli|img|file|doxcn|bascn|shtcn|wikcn)_?[A-Za-z0-9_-]{6,}$/.test(segment) ||
      /^[A-Za-z0-9_-]{20,}$/.test(segment)
        ? ':id'
        : segment,
    )
    .join('/')
}
