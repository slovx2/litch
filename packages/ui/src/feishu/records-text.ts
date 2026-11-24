// 记录与补历史对人说的几句：桌面和手机共用（手机的 t 是桌面文案的超集），不碰 DOM 与 React。
import { stamp } from '../app/format.ts'
import type { Translator } from '../i18n/index.ts'
import {
  type BackfillBlock,
  backfillLine,
  FEISHU_BACKFILL_LIMIT,
  type FeishuBackfill,
  type FeishuChatRecords,
  type FeishuGapFill,
  windowDays,
} from './model.ts'

/** 手动补历史不能做的原因，对人说的那句 */
export function backfillBlockText(why: Exclude<BackfillBlock, null>, t: Translator): string {
  return why === 'readOnly' ? t('feishu.readOnly') : t(`feishu.records.block.${why}`)
}

/** 条数与最早一条的时间，一句 */
export function recordsSummary(records: FeishuChatRecords, t: Translator): string {
  const count = t('feishu.records.count', { count: records.messages })
  if (records.oldestAt === undefined) return count
  const oldest = t('feishu.records.oldest', {
    time: stamp(records.oldestAt * 1000, Date.now(), t.lang),
  })
  return `${count} · ${oldest}`
}

/** 补历史一句：接入时补 / 手动补 · 起止日期 · 结果 */
export function backfillSummary(backfill: FeishuBackfill, t: Translator): string {
  const days = windowDays(backfill.start, backfill.end)
  return [
    t(`feishu.records.kind.${backfill.kind}`),
    t('feishu.records.window', days),
    t(`feishu.records.line.${backfillLine(backfill)}`, {
      fetched: backfill.fetched,
      max: FEISHU_BACKFILL_LIMIT,
    }),
  ].join(' · ')
}

/** 最近一次补缺口一句：时间、补到几条，没补全时注明 */
export function gapSummary(gap: FeishuGapFill, t: Translator): string {
  const line = t('feishu.records.gapLine', {
    time: stamp(gap.at * 1000, Date.now(), t.lang),
    fetched: gap.fetched,
  })
  return gap.complete ? line : `${line} · ${t('feishu.records.gapIncomplete')}`
}
