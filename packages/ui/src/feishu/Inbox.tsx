// 经理 Console 的飞书页签：群里有人 @ 机器人或回复机器人（且在叫醒名单里）、或私聊机器人时，设备记下的消息。
// 顶部分段“待处理（排队中、已送进回合）/ 已处理”；每条一行只放群名、发送人、身份、触发方式、状态、时间和一行正文，
// 点开看全文与各个时间。只读：处理完由经理用工具标记，界面不做处置按钮。
// 列表来自核心的 feishuInbox 快照（最近一页），“加载更多”按游标读更早的页，只留在本组件里。
import { useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import type { Translator } from '../i18n/index.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { useFeishuInbox, useFeishuRun } from './data.ts'
import {
  type FeishuInboxEntry,
  type FeishuInboxMessage,
  INBOX_SEGMENTS,
  type InboxSegment,
  type InboxShownStatus,
  inboxChatName,
  inboxShownStatus,
  inboxText,
  mergeInbox,
  queuedCount,
  segmentEntries,
  senderLabel,
} from './model.ts'

const STATUS_TONE: Record<InboxShownStatus, string> = {
  queued: 'pill wait',
  limited: 'pill wait',
  notified: 'pill ok',
  processed: 'pill mute',
}
const IDENTITY_TONE: Record<FeishuInboxEntry['senderIdentity'], string> = {
  bound: 'pill ok',
  member: 'pill mute',
  unknown: 'pill err',
}

/** Console 页签上的计数：排队中（还没送进经理回合）的条数，与收件箱共用同一份快照 */
export function useFeishuInboxSummary(
  manager: Pick<ManagerView, 'deviceId' | 'id'>,
  enabled: boolean,
): number {
  const view = useFeishuInbox(manager.deviceId, manager.id, enabled)
  return queuedCount(view?.value?.entries ?? [])
}

/** 正文显示成一句话：有字给原文，其余按情况给文案 */
export function inboxTextLine(t: Translator, message: FeishuInboxMessage | undefined): string {
  const text = inboxText(message)
  if (text.kind === 'text') return text.text
  if (text.kind === 'other') return t('feishu.inbox.text.other', { type: text.msgType })
  return t(`feishu.inbox.text.${text.kind}`)
}

function Detail({
  entry,
  message,
}: {
  entry: FeishuInboxEntry
  message: FeishuInboxMessage | undefined
}) {
  const t = useT()
  const text = inboxText(message)
  const status = inboxShownStatus(entry)
  return (
    <div className="ext-detail fs-inbox-detail" data-feishu-inbox-detail={entry.inboxId}>
      <p className="fs-inbox-full" data-kind={text.kind}>
        {inboxTextLine(t, message)}
      </p>
      {status === 'limited' ? <p className="fs-hint">{t('feishu.inbox.limitedNote')}</p> : null}
      <div className="ext-row-meta fs-inbox-meta">
        <span>
          {t('feishu.inbox.detail.sender')} {senderLabel(entry)}
          {entry.senderName ? <span className="mono"> · {entry.senderOpenId}</span> : null}
        </span>
        <span>
          {t('feishu.inbox.detail.sent')} <Stamp at={entry.createdAt * 1000} />
        </span>
        <span>
          {t('feishu.inbox.detail.received')} <Stamp at={entry.receivedAt * 1000} />
        </span>
        {entry.notifiedAt ? (
          <span>
            {t('feishu.inbox.detail.notified')} <Stamp at={entry.notifiedAt * 1000} />
          </span>
        ) : null}
        {entry.processedAt ? (
          <span>
            {t('feishu.inbox.detail.processed')} <Stamp at={entry.processedAt * 1000} />
          </span>
        ) : null}
        <span>
          {t('feishu.inbox.detail.id')} <span className="mono">{entry.inboxId}</span>
        </span>
      </div>
    </div>
  )
}

export function FeishuInbox({ manager }: { manager: ManagerView }) {
  const t = useT()
  const { channel } = useServices()
  const [segment, setSegment] = useState<InboxSegment>('open')
  const [open, setOpen] = useState<string | null>(null)
  /** 手动读到的更早几页；next 是再往前的游标 */
  const [older, setOlder] = useState<{
    entries: FeishuInboxEntry[]
    messages: Record<string, FeishuInboxMessage>
    next?: string
  } | null>(null)
  const view = useFeishuInbox(manager.deviceId, manager.id)
  const more = useFeishuRun()
  const latest = view?.value ?? null
  const all = latest ? mergeInbox(latest, older ?? { entries: [], messages: {} }) : null
  const rows = all ? segmentEntries(all.entries, segment) : []
  const openCount = all ? segmentEntries(all.entries, 'open').length : 0
  const cursor = older ? older.next : latest?.next
  const loadMore = async () => {
    if (!cursor) return
    const page = await more.run(() =>
      channel.command('feishu.inbox.list', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        before: cursor,
      }),
    )
    if (!page) return
    setOlder((now) => ({
      entries: [...(now?.entries ?? []), ...page.entries],
      messages: { ...now?.messages, ...page.messages },
      ...(page.next ? { next: page.next } : {}),
    }))
  }
  return (
    <div className="ext-inbox fs-inbox" data-feishu-inbox={segment}>
      <div className="ext-row">
        <div className="seg">
          {INBOX_SEGMENTS.map((one) => (
            <button
              type="button"
              key={one}
              data-feishu-inbox-seg={one}
              aria-pressed={segment === one}
              onClick={() => {
                setSegment(one)
                setOpen(null)
              }}
            >
              {t(`feishu.inbox.seg.${one}`)}
              {one === 'open' && openCount ? <span className="pill wait">{openCount}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {view?.error ? (
        <p className="err" role="alert">
          {view.error.text ? t.text(view.error.text) : view.error.message}
        </p>
      ) : null}
      {view && !view.online && view.fetchedAt ? (
        <p className="ext-empty">{t('feishu.offlineCached')}</p>
      ) : null}
      {all === null ? (
        view?.error ? null : (
          <p className="ext-empty">{t('feishu.loading')}</p>
        )
      ) : rows.length === 0 ? (
        <p className="ext-empty" data-feishu-inbox-empty>
          {t(`feishu.inbox.empty.${segment}`)}
        </p>
      ) : (
        <ul className="ext-list">
          {rows.map((entry) => {
            const expanded = open === entry.inboxId
            const message = all.messages[entry.inboxId]
            const status = inboxShownStatus(entry)
            const chat = inboxChatName(entry, message)
            return (
              <li
                key={entry.inboxId}
                className="ext-inbox-item fs-inbox-item"
                data-feishu-inbox-item={entry.inboxId}
                data-status={status}
              >
                <div className="ext-row">
                  <button
                    type="button"
                    className="ext-inbox-main"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : entry.inboxId)}
                  >
                    <Caret />
                    <b className="ell">{chat ?? t('feishu.inbox.direct')}</b>
                    <span className="dim ell">{senderLabel(entry)}</span>
                  </button>
                  <span
                    className={IDENTITY_TONE[entry.senderIdentity]}
                    title={t(`feishu.inbox.identityNote.${entry.senderIdentity}`)}
                  >
                    {t(`feishu.inbox.identity.${entry.senderIdentity}`)}
                  </span>
                  {/* 私聊的“群名”已写着私聊，触发方式不再重复 */}
                  {chat === null && entry.trigger === 'p2p' ? null : (
                    <span className="dim fs-inbox-trigger">
                      {t(`feishu.inbox.trigger.${entry.trigger}`)}
                    </span>
                  )}
                  <span className="grow" />
                  {/* 已处理一段里状态都一样，不再逐行写 */}
                  {segment === 'open' ? (
                    <span
                      className={STATUS_TONE[status]}
                      data-feishu-inbox-status={status}
                      title={status === 'limited' ? t('feishu.inbox.limitedNote') : undefined}
                    >
                      {t(`feishu.inbox.status.${status}`)}
                    </span>
                  ) : null}
                  <Stamp className="dim fs-inbox-time" at={entry.createdAt * 1000} />
                </div>
                {expanded ? (
                  <Detail entry={entry} message={message} />
                ) : (
                  <p className="fs-inbox-line ell" data-kind={inboxText(message).kind}>
                    {inboxTextLine(t, message)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {cursor ? (
        <button
          type="button"
          className="btn ghost"
          data-act="feishu-inbox-more"
          disabled={more.busy || view?.online === false}
          onClick={() => void loadMore()}
        >
          {t('feishu.inbox.more')}
        </button>
      ) : null}
      {more.error ? (
        <p className="err" role="alert">
          {more.error}
        </p>
      ) : null}
    </div>
  )
}
