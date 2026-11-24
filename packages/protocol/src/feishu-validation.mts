// litchFeishu 入站参数的形状校验，设备与核心共用。凭据、归属和权限仍由设备核验。
import {
  FEISHU_APP_ID,
  FEISHU_BOT_NAME_MAX,
  FEISHU_METHOD,
  FEISHU_SECRET_MAX,
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
