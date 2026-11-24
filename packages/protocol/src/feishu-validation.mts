// litchFeishu 入站参数的形状校验，设备与核心共用。凭据、归属和权限仍由设备核验。
import {
  FEISHU_APP_ID,
  FEISHU_BOT_NAME_MAX,
  FEISHU_CHAT_ID,
  FEISHU_METHOD,
  FEISHU_OPEN_ID,
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  FEISHU_SECRET_MAX,
  FEISHU_WAKERS_MAX,
  type FeishuMethod,
  type FeishuRequests,
} from './feishu.mjs'

type Check = (value: unknown) => boolean
const str =
  (max = 256, min = 1): Check =>
  (value) =>
    typeof value === 'string' && [...value].length >= min && [...value].length <= max
const int =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const pattern =
  (regex: RegExp): Check =>
  (value) =>
    typeof value === 'string' && regex.test(value)
const bool: Check = (value) => typeof value === 'boolean'
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value)

function obj(required: Record<string, Check> = {}, optional: Record<string, Check> = {}): Check {
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const fields = value as Record<string, unknown>
    return (
      Object.entries(required).every(
        ([key, check]) => Object.hasOwn(fields, key) && check(fields[key]),
      ) &&
      Object.entries(fields).every(
        ([key, field]) =>
          Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]?.(field)),
      )
    )
  }
}

const operationId = str(128)
const appId = pattern(FEISHU_APP_ID)
const logicalId = pattern(/^[A-Za-z0-9_-]{1,128}$/)
const revision = int(1)
// 机器人名去掉首尾空白后不能为空
const botName: Check = (value) =>
  str(FEISHU_BOT_NAME_MAX)(value) && (value as string).trim().length > 0
const secret = str(FEISHU_SECRET_MAX)
const chatId = pattern(FEISHU_CHAT_ID)
const speech: Check = (value) => value === 'free' || value === 'approval'
const inboxId = pattern(/^FI-[1-9][0-9]{0,15}$/)
const INBOX_STATUSES = new Set(['queued', 'notified', 'processed'])
const inboxStatuses: Check = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 3 &&
  new Set(value).size === value.length &&
  value.every((item) => INBOX_STATUSES.has(item))
const retentionDays = int(FEISHU_RETENTION_DAYS.min, FEISHU_RETENTION_DAYS.max)
const reviewTtlHours = int(FEISHU_REVIEW_TTL_HOURS.min, FEISHU_REVIEW_TTL_HOURS.max)
const wakers: Check = (value) =>
  Array.isArray(value) &&
  value.length <= FEISHU_WAKERS_MAX &&
  new Set(value).size === value.length &&
  value.every(pattern(FEISHU_OPEN_ID))
const chatRef = { appId, chatId }
const accessFields = { wakeBound: bool, wakers, retentionDays, reviewTtlHours }

const checks = {
  [FEISHU_METHOD.appList]: obj(),
  [FEISHU_METHOD.appGet]: obj({ appId }),
  [FEISHU_METHOD.appRegisterBegin]: obj({ operationId, name: botName }),
  [FEISHU_METHOD.appRegisterGet]: obj({ registrationId: logicalId }),
  [FEISHU_METHOD.appRegisterCancel]: obj({ registrationId: logicalId }),
  [FEISHU_METHOD.appConfigure]: obj({ operationId, appId, appSecret: secret }),
  [FEISHU_METHOD.appRotate]: obj({
    operationId,
    appId,
    appSecret: secret,
    expectedGeneration: revision,
  }),
  [FEISHU_METHOD.appUpdate]: obj(
    { appId, expectedRevision: revision },
    { managerId: nullable(logicalId), enabled: bool },
  ),
  [FEISHU_METHOD.appRemove]: obj({ appId, expectedRevision: revision }),
  [FEISHU_METHOD.appCheck]: obj({ appId }),
  [FEISHU_METHOD.appUpgrade]: obj({ appId, operationId }),
  [FEISHU_METHOD.chatList]: obj({ appId }, { refresh: bool }),
  [FEISHU_METHOD.chatGet]: obj(chatRef),
  [FEISHU_METHOD.chatMembers]: obj(chatRef, { refresh: bool }),
  [FEISHU_METHOD.chatAccess]: obj(
    { ...chatRef, expectedRevision: revision, speech, ...accessFields },
    { confirmExternal: bool },
  ),
  [FEISHU_METHOD.chatUpdate]: obj(
    { ...chatRef, expectedRevision: revision },
    { speech, ...accessFields },
  ),
  [FEISHU_METHOD.chatUnaccess]: obj({
    ...chatRef,
    expectedRevision: revision,
    deleteRecords: bool,
  }),
  [FEISHU_METHOD.chatBackfill]: (value) =>
    obj({ ...chatRef, start: int(), end: int() })(value) &&
    (value as { start: number }).start < (value as { end: number }).end,
  [FEISHU_METHOD.inboxList]: (value) =>
    obj(
      { managerId: logicalId },
      { statuses: inboxStatuses, before: inboxId, limit: int(1, 200) },
    )(value),
  [FEISHU_METHOD.inboxGet]: obj({ inboxId }),
} satisfies { [M in FeishuMethod]: Check }

export function isFeishuMethod(method: string): method is FeishuMethod {
  return Object.hasOwn(checks, method)
}

export function isFeishuMethodParams<M extends FeishuMethod>(
  method: M,
  params: unknown,
): params is FeishuRequests[M]['params'] {
  return checks[method](params ?? {})
}
