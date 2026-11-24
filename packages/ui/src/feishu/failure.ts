// 一次飞书命令没做成，对人怎么说。桌面和手机共用（手机的 t 是桌面文案的超集）。
import { whyNot } from '../app/errors.ts'
import type { Translator } from '../i18n/index.ts'
import { feishuReason } from './model.ts'

/** 设备给了原因代码的按代码说，其余照通用的说法 */
export function feishuFailure(error: unknown, t: Translator): string {
  const reason = feishuReason(error)
  if (reason) return t(`feishu.error.${reason}`)
  return t('feishu.failed', { reason: whyNot(error, t) })
}
