// 经理 Console 的 GitHub 收件箱：待分拣 / 已处理 / 被挡下三页签。每个候选一行（同一候选的多条事件聚成一行），
// 行上只放类别、主题、发起人资格、时间、提醒状态和外链；点开读设备的候选详情（证据事件、规则版本）并就地处置。
// 列表来自设备 externalInbox 快照（按经理过滤），处置后核心自己重读受影响的页。
import type { ExternalInboxEvent } from '@litch/core'
import { useEffect, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { ExternalIntake } from '../../../protocol/src/external-sources.mts'
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { type ManagerChoice, useDeviceManagers, useExternalInbox, useRun } from './data.ts'
import { InboxTriage } from './InboxTriage.tsx'
import { ManagerRecovery } from './ManagerRecovery.tsx'
import { MissingResultReply } from './MissingResultReply.tsx'
import {
  groupInbox,
  INBOX_TABS,
  type InboxTab,
  inboxFilter,
  subjectLabel,
  TRIAGE_REASONS,
} from './model.ts'
import { reasonText } from './Preview.tsx'
import { ExtLink } from './parts.tsx'

const DELIVERY_TONE = {
  queued: 'pill mute',
  sending: 'pill wait',
  confirmed: 'pill ok',
  unknown: 'pill err',
  blocked: 'pill err',
} as const

/** Console 分段上的待分拣数：与收件箱共用同一份快照 */
export function useInboxSummary(manager: Pick<ManagerView, 'deviceId' | 'id'>, enabled: boolean) {
  const view = useExternalInbox(manager.deviceId, inboxFilter('pending', manager.id), enabled)
  const rows = view?.value?.entries ?? []
  return {
    pending: groupInbox(rows).length,
    blocked: rows.find(({ delivery }) => delivery?.recovery)?.delivery,
  }
}

function Role({ event }: { event: ExternalInboxEvent }) {
  const t = useT()
  const role = event.actorRoleAtCheck
  if (!role) return null
  return (
    <span
      className={role === 'owner' ? 'pill ok' : role === 'read' ? 'pill err' : 'pill mute'}
      title={event.actorId ? `#${event.actorId}` : undefined}
    >
      {role === 'owner' ? t('ext.inbox.owner') : role}
    </span>
  )
}

function Detail({
  manager,
  head,
  access,
  managers,
  disabled,
  onOpenIssue,
}: {
  manager: ManagerView
  head: ExternalInboxEvent
  access: Parameters<typeof InboxTriage>[0]['access']
  managers: ManagerChoice[]
  disabled: boolean
  onOpenIssue(id: string): void
}) {
  const t = useT()
  const { channel } = useServices()
  const load = useRun()
  const [detail, setDetail] = useState<{
    events: ExternalInboxEvent[]
    intake: ExternalIntake | null
  } | null>(null)
  const revision = head.revision
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条目版本变了重读
  useEffect(() => {
    void load
      .run(() =>
        channel.command(
          'external.inbox.get',
          head.intakeId
            ? { deviceId: manager.deviceId, intakeId: head.intakeId }
            : { deviceId: manager.deviceId, eventKey: head.eventKey },
        ),
      )
      .then((result) => {
        if (result) setDetail(result)
      })
  }, [channel, manager.deviceId, head.intakeId, head.eventKey, revision])
  const events = detail?.events ?? [head]
  const issueId = detail?.intake?.issueId ?? head.issueId
  return (
    <div className="ext-detail" data-inbox-detail={head.eventKey}>
      <div className="ext-row ext-row-meta">
        {head.missingResultReply ? <MissingResultReply reply={head.missingResultReply} /> : null}
        {head.ruleId ? (
          <span>
            {t('ext.inbox.rule')} <span className="mono">{head.ruleId}</span>
            {head.rulesVersion ? ` v${head.rulesVersion}` : ''}
          </span>
        ) : null}
        {head.reason ? <span>{reasonText(t, head.reason)}</span> : null}
        {head.delivery?.reason && head.delivery.reason !== head.reason ? (
          <span>{reasonText(t, head.delivery.reason)}</span>
        ) : null}
        {head.delivery?.recovery ? (
          <ManagerRecovery
            deviceId={manager.deviceId}
            recovery={head.delivery.recovery}
            disabled={disabled}
          />
        ) : null}
        {issueId ? (
          <button
            type="button"
            className="ext-text-link mono"
            data-act="inbox-issue"
            onClick={() => onOpenIssue(issueId)}
          >
            {issueId}
          </button>
        ) : null}
      </div>
      <ul className="ext-diags">
        {events.map((event) => (
          <li key={event.eventKey} className="ext-diag" data-event={event.eventKey}>
            <span>{t(`ext.kind.${event.kind}`)}</span>
            <Role event={event} />
            {event.actorId ? <span className="dim mono">#{event.actorId}</span> : null}
            <Stamp className="dim" at={event.occurredAt * 1000} />
            <span className="grow" />
            <ExtLink url={event.eventUrl} />
          </li>
        ))}
      </ul>
      {load.error ? (
        <div className="err" role="alert">
          {load.error}
        </div>
      ) : null}
      {detail?.intake ? (
        <InboxTriage
          manager={manager}
          intake={detail.intake}
          access={access}
          managers={managers}
          disabled={disabled}
          onDone={() => {}}
        />
      ) : null}
    </div>
  )
}

export function ExternalInbox({
  manager,
  disabled,
  onOpenIssue,
}: {
  manager: ManagerView
  disabled: boolean
  onOpenIssue(id: string): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [tab, setTab] = useState<InboxTab>('pending')
  const [reason, setReason] = useState('')
  const [onlyNotified, setOnlyNotified] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const filter = inboxFilter(tab, manager.id, { reason, onlyNotified })
  const view = useExternalInbox(manager.deviceId, filter)
  const { pending } = useInboxSummary(manager, true)
  const managers = useDeviceManagers(manager.deviceId)
  const more = useRun()
  const page = view?.value ?? null
  const rows = page ? groupInbox(page.entries) : []
  return (
    <div className="ext-inbox" data-ext-inbox={tab}>
      <div className="ext-row">
        <div className="seg">
          {INBOX_TABS.map((one) => (
            <button
              type="button"
              key={one}
              data-inbox-status={one}
              aria-pressed={tab === one}
              onClick={() => {
                setTab(one)
                setOpen(null)
              }}
            >
              {t(`ext.inbox.${one}`)}
              {one === 'pending' && pending ? <span className="pill wait">{pending}</span> : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        {tab === 'pending' ? (
          <select
            className="ext-select"
            aria-label={t('ext.inbox.reason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          >
            <option value="">{t('ext.inbox.allReasons')}</option>
            {TRIAGE_REASONS.filter((one) => one !== 'manual').map((one) => (
              <option key={one} value={one}>
                {t(`ext.reason.${one}`)}
              </option>
            ))}
          </select>
        ) : tab === 'processed' ? (
          <button
            type="button"
            className="ext-chip"
            data-act="only-notified"
            aria-pressed={onlyNotified}
            onClick={() => setOnlyNotified(!onlyNotified)}
          >
            {t('ext.status.notified')}
          </button>
        ) : null}
      </div>
      {view?.error ? (
        <p className="err" role="alert">
          {view.error.text ? t.text(view.error.text) : view.error.message}
        </p>
      ) : null}
      {!view?.online && view?.fetchedAt ? (
        <p className="ext-empty">
          {t('ext.inbox.cached')} <Stamp at={view.fetchedAt} />
        </p>
      ) : null}
      {page === null ? (
        <p className="ext-empty">{t('ext.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="ext-empty">{t(`ext.inbox.empty.${tab}`)}</p>
      ) : (
        <ul className="ext-list">
          {rows.map(({ head, count }) => {
            const key = head.intakeId ?? head.eventKey
            const expanded = open === key
            return (
              <li key={key} className="ext-inbox-item" data-inbox-item={key}>
                <div className="ext-row">
                  <button
                    type="button"
                    className="ext-inbox-main"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : key)}
                  >
                    <Caret />
                    <span className="mono ell">{subjectLabel(head.subject)}</span>
                    <span className="dim">{t(`ext.kind.${head.kind}`)}</span>
                    {count > 1 ? <span className="pill mute">×{count}</span> : null}
                  </button>
                  <Role event={head} />
                  <Stamp className="dim" at={head.observedAt * 1000} />
                  <span className="grow" />
                  {tab === 'pending' && head.delivery ? (
                    <span
                      className={
                        head.delivery.recovery ? 'pill wait' : DELIVERY_TONE[head.delivery.state]
                      }
                      title={head.delivery.reason ? reasonText(t, head.delivery.reason) : undefined}
                    >
                      {/* 原因放悬停提示；全文和恢复入口在展开的详情里 */}
                      {t(`ext.delivery.${head.delivery.state}`)}
                    </span>
                  ) : tab === 'blocked' ? (
                    <span className="pill err">{reasonText(t, head.reason)}</span>
                  ) : tab === 'processed' ? (
                    head.issueId ? (
                      <button
                        type="button"
                        className="pill mute mono"
                        onClick={() => onOpenIssue(head.issueId as string)}
                      >
                        {head.issueId}
                      </button>
                    ) : (
                      <span className="pill mute">
                        {head.reason === 'external_closed' || head.reason === 'external_merged'
                          ? reasonText(t, head.reason)
                          : t(`ext.status.${head.status}`)}
                      </span>
                    )
                  ) : null}
                  <ExtLink url={head.eventUrl} />
                </div>
                {expanded ? (
                  <Detail
                    manager={manager}
                    head={head}
                    access={view?.access}
                    managers={managers}
                    disabled={disabled}
                    onOpenIssue={onOpenIssue}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {page?.nextBeforeSeq ? (
        <button
          type="button"
          className="btn ghost"
          data-act="inbox-more"
          disabled={more.busy}
          onClick={() =>
            void more.run(() =>
              channel.command('external.inbox.more', { deviceId: manager.deviceId, filter }),
            )
          }
        >
          {t('ext.inbox.more')}
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
