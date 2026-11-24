// 一次飞书命令没做成，对人怎么说。桌面和手机共用（手机的 t 是桌面文案的超集）。
import { whyNot } from '../app/errors.ts'
import type { Translator } from '../i18n/index.ts'
import { feishuReason, grantFail, reviewReason } from './model.ts'

/** 设备给了原因代码的按代码说，其余照通用的说法 */
export function feishuFailure(error: unknown, t: Translator): string {
  const reason = feishuReason(error)
  if (reason) return t(`feishu.error.${reason}`)
  return t('feishu.failed', { reason: whyNot(error, t) })
}

/** 审批命令没做成：审批的原因代码（review_*）按代码说，其余同 feishuFailure */
export function reviewFailure(error: unknown, t: Translator): string {
  const reason = reviewReason(error)
  if (reason) return t(`feishu.review.error.${reason}`)
  return feishuFailure(error, t)
}

/** 授权命令没做成：授权的原因代码按代码说，其余同 feishuFailure */
export function grantFailure(error: unknown, t: Translator): string {
  const reason = grantFail(error)
  if (reason) return t(`feishu.grant.fail.${reason}`)
  return feishuFailure(error, t)
}
