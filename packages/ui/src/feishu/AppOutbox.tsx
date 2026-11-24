// 应用详情 · 发件：经理经这个应用的发言（发件队列，新的在前）。每条一行：发到哪、格式、分几条、状态、时间，
// 下面一行内容摘要，有原因时跟在后面（结果不明且已停止重发时提示到群里核对）；审批 ID 与尝试次数放在行尾。
// 以用户身份发的在格式后标“以 某某 身份发”；经 lark-cli 发的再加一行小字写方法、路径和动作。
// 待审批、排队、结果不明的可撤下（确认后调 feishu.outbox.cancel）；已发出的不撤回飞书上的消息。
// 列表来自核心的 feishuOutbox 快照（最近一页），“加载更多”按游标读更早的页，只留在本组件里。
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { Ban } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { useFeishuOutbox, useFeishuRun } from './data.ts'
import {
  canCancelOutbox,
  type FeishuOutboxEntry,
  mergeOutbox,
  OUTBOX_TONE,
  outboxReason,
  type WriteBlock,
} from './model.ts'
import { actingUserText, cliText, outboxReasonText, targetLabel } from './speech-text.ts'

const TONE_PILL = { ok: 'pill ok', wait: 'pill wait', err: 'pill err', off: 'pill mute' } as const

export function AppOutbox({
  deviceId,
  appId,
  block,
}: {
  deviceId: string
  appId: string
  /** 写操作为什么不能做；null 是能做 */
  block: WriteBlock
}) {
  const t = useT()
  const { channel } = useServices()
  const view = useFeishuOutbox(deviceId, appId)
  const [older, setOlder] = useState<{ entries: FeishuOutboxEntry[]; next?: string } | null>(null)
  const [canceling, setCanceling] = useState<FeishuOutboxEntry | null>(null)
  const more = useFeishuRun()
  const act = useFeishuRun()
  const latest = view?.value ?? null
  const rows = latest ? mergeOutbox(latest.entries, older?.entries ?? []) : null
  const cursor = older ? older.next : latest?.next
  const denied =
    block === 'readOnly' ? t('feishu.readOnly') : block ? t('feishu.offline') : undefined

  const loadMore = async () => {
    if (!cursor) return
    const page = await more.run(() =>
      channel.command('feishu.outbox.list', { deviceId, appId, before: cursor }),
    )
    if (!page) return
    setOlder((now) => ({
      entries: [...(now?.entries ?? []), ...page.entries],
      ...(page.next ? { next: page.next } : {}),
    }))
  }
  const cancel = async (entry: FeishuOutboxEntry) => {
    setCanceling(null)
    await act.run(() =>
      channel.command('feishu.outbox.cancel', {
        deviceId,
        appId,
        operationId: entry.operationId,
      }),
    )
  }

  const error = view?.error ?? null
  return (
    <section className="ext-block" data-feishu-outbox>
      <div className="ext-block-head">
        <h3>{t('feishu.outbox.title')}</h3>
      </div>
      <p className="fs-hint">{t('feishu.outbox.note')}</p>
      {error ? (
        <div className="devp-note err" role="alert">
          {error.text ? t.text(error.text) : error.message}
        </div>
      ) : null}
      {act.error ? (
        <div className="devp-note err" role="alert" data-feishu-outbox-error>
          {act.error}
        </div>
      ) : null}
      {rows === null ? (
        error ? null : (
          <div className="ext-empty">{t('feishu.loading')}</div>
        )
      ) : rows.length === 0 ? (
        <div className="ext-empty">{t('feishu.outbox.none')}</div>
      ) : (
        <ul className="ext-list">
          {rows.map((entry) => {
            const reason = outboxReason(entry)
            const reasonText = outboxReasonText(t, entry)
            const acting = actingUserText(t, entry.actingAs)
            return (
              <li
                key={entry.operationId}
                className="fs-outbox-item"
                data-feishu-outbox-item={entry.operationId}
                data-state={entry.state}
              >
                <div className="ext-row">
                  <b className="ext-row-name ell">{targetLabel(t, entry.target)}</b>
                  <span className="pill mute">{t(`feishu.format.${entry.format}`)}</span>
                  {acting ? (
                    <span className="pill mute fs-acting ell" data-feishu-acting>
                      {acting}
                    </span>
                  ) : null}
                  {entry.parts > 1 ? (
                    <span className="ext-row-meta fs-nowrap">
                      {t('feishu.outbox.parts', { n: entry.parts })}
                    </span>
                  ) : null}
                  <span className="grow" />
                  {entry.reviewId ? (
                    <span className="ext-row-meta fs-nowrap">
                      {t('feishu.outbox.review', { id: entry.reviewId })}
                    </span>
                  ) : null}
                  <span
                    className={TONE_PILL[OUTBOX_TONE[entry.state]]}
                    data-feishu-outbox-state={entry.state}
                    title={
                      entry.attempts > 1
                        ? t('feishu.outbox.attempts', { n: entry.attempts })
                        : undefined
                    }
                  >
                    {t(`feishu.outbox.state.${entry.state}`)}
                  </span>
                  <Stamp
                    className="dim fs-inbox-time"
                    at={(entry.sentAt ?? entry.createdAt) * 1000}
                  />
                  {canCancelOutbox(entry.state) ? (
                    <button
                      type="button"
                      className="ibtn"
                      data-act="feishu-outbox-cancel"
                      title={denied ?? t('feishu.outbox.cancel')}
                      aria-label={t('feishu.outbox.cancel')}
                      disabled={block !== null || act.busy}
                      onClick={() => setCanceling(entry)}
                    >
                      <Ban />
                    </button>
                  ) : null}
                </div>
                <p className="fs-inbox-line fs-outbox-line ell" data-kind="text">
                  {entry.summary}
                  {reason ? (
                    <span className="fs-outbox-reason" data-feishu-outbox-reason={reason}>
                      {' · '}
                      {reasonText}
                    </span>
                  ) : null}
                </p>
                {entry.cli ? (
                  <p className="fs-cli mono ell" data-feishu-cli title={cliText(t, entry.cli)}>
                    {cliText(t, entry.cli)}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {cursor ? (
        <div className="ext-actions">
          <button
            type="button"
            className="btn ghost"
            data-act="feishu-outbox-more"
            disabled={more.busy || view?.online === false}
            onClick={() => void loadMore()}
          >
            {t('feishu.inbox.more')}
          </button>
        </div>
      ) : null}
      {more.error ? (
        <p className="err" role="alert">
          {more.error}
        </p>
      ) : null}
      {canceling ? (
        <Confirm
          title={t('feishu.outbox.cancel.title')}
          note={t(
            canceling.state === 'unknown'
              ? 'feishu.outbox.cancel.noteUnknown'
              : 'feishu.outbox.cancel.note',
          )}
          yes={t('feishu.outbox.cancel')}
          no={t('feishu.cancel')}
          onYes={() => void cancel(canceling)}
          onClose={() => setCanceling(null)}
        />
      ) : null}
    </section>
  )
}
