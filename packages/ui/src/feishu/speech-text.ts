// 审批与发件对人说的几句：桌面和手机共用（手机的 t 是桌面文案的超集），不碰 DOM 与 React。
import type { Translator } from '../i18n/index.ts'
import {
  type FeishuCliRequest,
  type FeishuOutboxEntry,
  outboxReason,
  type ReviewSpeechPreview,
  type TimeLeft,
} from './model.ts'

/** 发到哪：群名；私聊写“私聊 · 名字”；没有名字时用 ID */
export function targetLabel(t: Translator, target: ReviewSpeechPreview['target']): string {
  const name = target.name.trim() || target.id
  return target.kind === 'user' ? t('feishu.target.user', { name }) : name
}

/** 以谁的身份发：机器人（写应用名），或“以某某的身份” */
export function actingLabel(t: Translator, preview: ReviewSpeechPreview): string {
  return preview.actingAs.type === 'bot'
    ? t('feishu.review.actingAs.bot', { app: preview.appName || preview.appId })
    : t('feishu.review.actingAs.user', { name: preview.actingAs.name || preview.actingAs.openId })
}

/** @ 到的人，用顿号连起来；没有名字的用 open_id */
export function mentionNames(preview: Pick<ReviewSpeechPreview, 'mentions'>): string {
  return preview.mentions.map((one) => one.name.trim() || one.openId).join('、')
}

/** 剩余时间一句：剩 3 天 / 剩 5 小时 / 剩 12 分钟 */
export function timeLeftText(t: Translator, left: TimeLeft): string {
  return t(`feishu.review.left.${left.unit}`, { n: left.n })
}

/** 发件行的原因一句；没有要写的原因时是 null */
export function outboxReasonText(
  t: Translator,
  entry: Pick<FeishuOutboxEntry, 'state' | 'error'>,
): string | null {
  const reason = outboxReason(entry)
  return reason ? t(`feishu.outbox.error.${reason}`, { code: entry.error ?? '' }) : null
}

/** 经 lark-cli 发的：一行写方法、路径和动作，如“经 lark-cli · POST /open-apis/im/v1/messages · send” */
export function cliText(t: Translator, cli: FeishuCliRequest): string {
  return t('feishu.cli.line', { method: cli.method, path: cli.path, action: cli.action })
}

/** 以用户身份发的标记“以 某某 身份发”；机器人发的是 null */
export function actingUserText(
  t: Translator,
  actingAs: FeishuOutboxEntry['actingAs'] | ReviewSpeechPreview['actingAs'] | undefined,
): string | null {
  if (actingAs?.type !== 'user') return null
  return t('feishu.actingAsUser', { name: actingAs.name.trim() || actingAs.openId })
}
