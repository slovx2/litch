// 群设置里的“记录”一块：记录条数与最早一条的时间；已接入的群另有补历史的进度与结果、最近一次补缺口，
// 以及“补更早的消息”（选起止日期，开始取那天本地零点，结束取次日零点和现在中较早的那个）。
// 未接入但留着记录的群只显示条数和最早时间。
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { stamp } from '../app/format.ts'
import { useServices } from '../app/services.tsx'
import { Field } from '../external/parts.tsx'
import { type OnChat, useFeishuRun } from './data.ts'
import {
  backfillBlock,
  backfillDefaults,
  backfillLine,
  backfillWindow,
  dayText,
  FEISHU_BACKFILL_LIMIT,
  type FeishuChat,
  type WriteBlock,
} from './model.ts'
import { backfillBlockText, backfillSummary, recordsSummary } from './records-text.ts'

export function ChatRecords({
  deviceId,
  chat,
  block,
  onChat,
}: {
  deviceId: string
  chat: FeishuChat
  block: WriteBlock
  onChat: OnChat
}) {
  const t = useT()
  const { channel } = useServices()
  const records = chat.records
  const [days, setDays] = useState(() => backfillDefaults(records, Date.now()))
  const act = useFeishuRun()
  if (!chat.access) {
    if (!records) return null
    return (
      <div className="form-field" data-feishu-records="kept">
        <span className="form-label">{t('feishu.records.title')}</span>
        <span className="fs-records-line">{recordsSummary(records, t)}</span>
        <span className="fs-hint">{t('feishu.records.keptNote')}</span>
      </div>
    )
  }
  const backfill = records?.backfill
  const gap = records?.gap
  const why = backfillBlock(chat, block)
  const range = backfillWindow(days.from, days.to, Date.now())
  const problem = 'problem' in range ? range.problem : null
  const start = async () => {
    if (why || 'problem' in range) return
    const result = await act.run(() =>
      channel.command('feishu.chat.backfill', {
        deviceId,
        appId: chat.appId,
        chatId: chat.chatId,
        start: range.start,
        end: range.end,
      }),
    )
    if (result) onChat(result.chat)
  }
  return (
    <div className="form-field fs-records" data-feishu-records="access">
      <span className="form-label">{t('feishu.records.title')}</span>
      <span className="fs-records-line">
        {records ? recordsSummary(records, t) : t('feishu.records.empty')}
      </span>
      {backfill ? (
        <Field label={t('feishu.records.backfill')}>
          <span
            className={backfill.state === 'failed' ? 'fs-hint err' : 'fs-records-line'}
            data-feishu-backfill={backfillLine(backfill)}
          >
            {backfillSummary(backfill, t)}
          </span>
        </Field>
      ) : null}
      {gap ? (
        <Field label={t('feishu.records.gap')}>
          <span className="fs-records-line" data-feishu-gap>
            {t('feishu.records.gapLine', {
              time: stamp(gap.at * 1000, Date.now(), t.lang),
              fetched: gap.fetched,
            })}
          </span>
          {gap.complete ? null : (
            <span className="pill wait">{t('feishu.records.gapIncomplete')}</span>
          )}
        </Field>
      ) : null}
      <span className="form-label fs-records-more">{t('feishu.records.more')}</span>
      <div className="fs-records-form">
        <label className="fs-form-row">
          <span>{t('feishu.records.from')}</span>
          <input
            className={problem ? 'req-input wrong' : 'req-input'}
            type="date"
            value={days.from}
            max={dayText(Date.now())}
            disabled={why !== null}
            data-feishu-backfill-from
            onChange={(event) => setDays({ ...days, from: event.target.value })}
          />
        </label>
        <label className="fs-form-row">
          <span>{t('feishu.records.to')}</span>
          <input
            className={problem ? 'req-input wrong' : 'req-input'}
            type="date"
            value={days.to}
            max={dayText(Date.now())}
            disabled={why !== null}
            data-feishu-backfill-to
            onChange={(event) => setDays({ ...days, to: event.target.value })}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-act="feishu-backfill"
          disabled={why !== null || problem !== null || act.busy}
          title={why ? backfillBlockText(why, t) : undefined}
          onClick={() => void start()}
        >
          {t('feishu.records.start')}
        </button>
      </div>
      <span className="fs-hint">
        {t('feishu.records.moreNote', { max: FEISHU_BACKFILL_LIMIT })}
      </span>
      {/* 离线、只读的原因对话框顶上已经写了 */}
      {why && why !== 'readOnly' && why !== 'offline' ? (
        <span className="fs-hint err" data-feishu-backfill-why>
          {backfillBlockText(why, t)}
        </span>
      ) : problem ? (
        <span className="fs-hint err">{t(`feishu.records.problem.${problem}`)}</span>
      ) : null}
      {act.error ? (
        <span className="fs-hint err" role="alert">
          {act.error}
        </span>
      ) : null}
    </div>
  )
}
