// 收件箱候选的人工处置：接单（新建 X-n）、并入已有 X-n、忽略（可附回复）、改派给同设备的经理。
// 哪几项可用只看 access（triageInbox / reassignInbox）；提交带候选版本与一次性处置键，冲突时说明原因。
import type { ExternalAccess, ExternalTriageAction } from '@litch/core'
import { useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { ExternalIntake } from '../../../protocol/src/external-sources.mts'
import type { ManagerIssueId } from '../../../protocol/src/manager-issues.mts'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { type ManagerChoice, useRun } from './data.ts'
import { allowed, operationId } from './model.ts'

type Mode = 'accept' | 'merge' | 'ignore' | 'reassign'

export function InboxTriage({
  manager,
  intake,
  access,
  managers,
  disabled,
  onDone,
}: {
  manager: Pick<ManagerView, 'deviceId' | 'id'>
  intake: ExternalIntake
  access: ExternalAccess | undefined
  managers: ManagerChoice[]
  disabled: boolean
  onDone(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [mode, setMode] = useState<Mode | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reply, setReply] = useState('')
  const [reason, setReason] = useState('')
  const [target, setTarget] = useState('')
  const [to, setTo] = useState('')
  const act = useRun()
  const triage = allowed(access, 'triageInbox')
  const reassign = allowed(access, 'reassignInbox')
  if (intake.status !== 'pending_triage' || (!triage && !reassign)) return null
  const modes = [
    ...(triage ? (['accept', 'merge', 'ignore'] as const) : []),
    ...(reassign ? (['reassign'] as const) : []),
  ]
  const others = managers.filter((one) => one.id !== (intake.managerId ?? manager.id))
  const withReply = reply.trim() ? { reply: reply.trim() } : {}

  const submit = async () => {
    let action: ExternalTriageAction
    if (mode === 'accept') action = { action: 'accept', title: title.trim(), body, ...withReply }
    else if (mode === 'ignore') action = { action: 'ignore', reason: reason.trim(), ...withReply }
    else if (mode === 'reassign') action = { action: 'reassign', managerId: to }
    else {
      const id = target.trim().toUpperCase() as ManagerIssueId
      const detail = await act.run(() =>
        channel.command('managers.issue.read', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          id,
        }),
      )
      if (!detail) return
      action = {
        action: 'merge',
        issueId: id as Extract<ManagerIssueId, `X-${number}`>,
        expectedIssueRevision: detail.issue.revision,
        ...withReply,
      }
    }
    const result = await act.run(() =>
      channel.command('external.inbox.triage', {
        deviceId: manager.deviceId,
        ...action,
        intakeId: intake.intakeId,
        expectedRevision: intake.revision,
        idempotencyKey: operationId(),
      }),
    )
    if (!result) return
    if (result.outcome === 'conflict') {
      act.setError(t(`ext.triage.conflict.${result.reason}`))
      return
    }
    if (result.reply && 'notQueued' in result.reply) act.setError(t('ext.triage.replyNotSent'))
    setMode(null)
    onDone()
  }

  const ready =
    mode === 'accept'
      ? title.trim().length > 0
      : mode === 'merge'
        ? /^X-\d+$/iu.test(target.trim())
        : mode === 'ignore'
          ? reason.trim().length > 0
          : mode === 'reassign'
            ? Boolean(to)
            : false
  const off = disabled || act.busy
  return (
    <div className="ext-triage" data-ext-triage>
      <div className="ext-row">
        {modes.map((one) => (
          <button
            type="button"
            key={one}
            className={mode === one ? 'btn' : 'btn ghost'}
            data-act={`triage-${one}`}
            aria-pressed={mode === one}
            disabled={off || (one === 'reassign' && others.length === 0)}
            onClick={() => {
              setMode(mode === one ? null : one)
              act.setError('')
            }}
          >
            {t(`ext.triage.${one}`)}
          </button>
        ))}
      </div>
      {mode === 'accept' ? (
        <>
          <input
            className="req-input"
            value={title}
            placeholder={t('ext.triage.title')}
            aria-label={t('ext.triage.title')}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            className="req-input ext-text"
            value={body}
            rows={3}
            placeholder={t('ext.triage.body')}
            aria-label={t('ext.triage.body')}
            onChange={(event) => setBody(event.target.value)}
          />
        </>
      ) : mode === 'merge' ? (
        <input
          className="req-input mono"
          value={target}
          placeholder="X-1"
          aria-label={t('ext.triage.target')}
          onChange={(event) => setTarget(event.target.value)}
        />
      ) : mode === 'ignore' ? (
        <input
          className="req-input"
          value={reason}
          placeholder={t('ext.triage.reason')}
          aria-label={t('ext.triage.reason')}
          onChange={(event) => setReason(event.target.value)}
        />
      ) : mode === 'reassign' ? (
        <select
          className="ext-select"
          value={to}
          aria-label={t('ext.triage.to')}
          onChange={(event) => setTo(event.target.value)}
        >
          <option value="">{t('ext.triage.to')}</option>
          {others.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      ) : null}
      {mode && mode !== 'reassign' ? (
        <input
          className="req-input"
          value={reply}
          placeholder={t('ext.triage.reply')}
          aria-label={t('ext.triage.reply')}
          onChange={(event) => setReply(event.target.value)}
        />
      ) : null}
      {mode ? (
        <div className="ext-actions">
          {act.error ? (
            <span className="err grow" role="alert">
              {act.error}
            </span>
          ) : (
            <span className="grow" />
          )}
          <button
            type="button"
            className="btn primary"
            data-act="triage-submit"
            disabled={off || !ready}
            onClick={() => void submit()}
          >
            {t(`ext.triage.${mode}.yes`)}
          </button>
        </div>
      ) : act.error ? (
        <div className="err" role="alert">
          {act.error}
        </div>
      ) : null}
    </div>
  )
}
