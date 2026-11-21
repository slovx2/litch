// 一个仓库（来源）展开后的设置：触发、门槛、标签路由、即时反馈、采集身份、本机目录与 base、回写、轮询间隔、
// 自动提醒经理；下面是就绪四项的诊断（可重新检查）与各流的覆盖。改了才出“预览/保存”；保存按来源版本提交。
import {
  type DeviceView,
  type ExternalDiagnostic,
  type ExternalIdentityRepository,
  type ExternalSourceDraft,
  type ExternalSourceStatus,
  externalSourceDraft,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { type ManagerChoice, useRun } from './data.ts'
import { ManagerRecovery } from './ManagerRecovery.tsx'
import { type IdentityHead, operationId, READINESS_AREAS } from './model.ts'
import { PreviewResult, type PreviewValue } from './Preview.tsx'
import { Dot, Field, readinessTone, Switch } from './parts.tsx'

const ROLES = ['triage', 'write', 'maintain', 'admin'] as const
const INTERVALS = [60, 120, 300, 600] as const
const TRIGGERS = ['mention', 'assignment', 'reviewRequest', 'label'] as const

const KNOWN_CODES = new Set([
  'github_collection_available',
  'github_collection_blocked',
  'github_notifications_unverified',
  'github_notifications_ready',
  'github_notifications_scope_required',
  'github_notifications_access_denied',
  'github_notifications_unavailable',
  'github_notifications_rate_limited',
  'source_paused',
  'auto_notify_disabled',
  'manager_tools_ready',
  'manager_tools_outdated',
  'manager_inactive',
  'manager_unassigned',
  'agent_uses_device_credentials',
  'device_autostart_ready',
  'device_autostart_unverified',
  'manualInstance',
  'agent_github_identity_unverified',
  'agent_github_owner_login_may_feed_back',
  'agent_github_owner_login_not_detected',
  'github_repository_write_permission_unverified',
  'github_feedback_write_permission_required',
  'github_robot_needs_repository_write_access',
  'github_local_root_invalid',
  'github_local_origin_mismatch',
  'github_repository_unreachable',
  'github_repository_outside_credential',
  'github_repository_verified',
  'github_preview_limited',
])

export function Diagnostic({
  item,
  deviceId,
  canCheck,
}: {
  item: ExternalDiagnostic
  deviceId?: string
  canCheck?: boolean
}) {
  const t = useT()
  const known = KNOWN_CODES.has(item.code)
  return (
    <li className="ext-diag" data-check={item.check} data-state={item.state}>
      <Dot tone={readinessTone[item.state]} label={t(`ext.ready.state.${item.state}`)} />
      <span className="ell">
        {item.check === 'immediateFeedbackComments' && item.state === 'blocked'
          ? t('ext.diag.feedbackOff')
          : known
            ? t(`ext.code.${item.code}` as Parameters<typeof t>[0])
            : t('ext.diag.unknown')}
      </span>
      {item.checkedAt ? <Stamp className="dim" at={item.checkedAt * 1000} /> : null}
      {deviceId && item.recovery ? (
        <ManagerRecovery deviceId={deviceId} recovery={item.recovery} disabled={!canCheck} />
      ) : null}
    </li>
  )
}

export function RepoDetail({
  device,
  status,
  identities,
  repositories,
  managers,
  writable,
}: {
  device: DeviceView
  status: ExternalSourceStatus
  identities: IdentityHead[]
  repositories: ExternalIdentityRepository[]
  managers: ManagerChoice[]
  writable: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const [draft, setDraft] = useState<ExternalSourceDraft>(() => externalSourceDraft(status.source))
  const [base] = useState(() => JSON.stringify(externalSourceDraft(status.source)))
  const [preview, setPreview] = useState<PreviewValue | null>(null)
  const act = useRun()
  const repo = draft.repos[0]
  if (!repo) return null
  const dirty = JSON.stringify(draft) !== base
  const changed = status.source.revision
  const online = device.connection === 'online'
  const readable = repositories.find((one) => one.repoId === repo.repoId)?.grants ?? []
  const pollChoices = identities.filter(
    (one) => !readable.length || readable.some((g) => g.identityId === one.identityId && g.read),
  )
  const setRepo = (patch: Partial<typeof repo>) => {
    setPreview(null)
    setDraft({ ...draft, repos: [{ ...repo, ...patch }] })
  }
  const set = (patch: Partial<ExternalSourceDraft>) => {
    setPreview(null)
    setDraft({ ...draft, ...patch })
  }
  const label = draft.triggers.labelIds[0]
  const route = repo.labelRoutes?.find((one) => one.labelId === label)

  const save = () =>
    act.run(() =>
      channel.command('external.source.upsert', {
        deviceId: device.id,
        source: draft,
        expectedRevision: changed,
        operationId: operationId(),
      }),
    )
  const runPreview = async () => {
    const result = await act.run(() =>
      channel.command('external.source.preview', { deviceId: device.id, source: draft }),
    )
    if (result) setPreview(result)
  }
  const disabled = !online || !writable || act.busy

  return (
    <div className="ext-detail" data-ext-detail={status.source.sourceId}>
      <Field label={t('ext.repo.triggers')}>
        <span className="ext-chips">
          {TRIGGERS.map((key) => (
            <button
              type="button"
              key={key}
              className="ext-chip"
              data-trigger={key}
              aria-pressed={draft.triggers[key]}
              disabled={disabled || (key === 'label' && !label)}
              onClick={() => set({ triggers: { ...draft.triggers, [key]: !draft.triggers[key] } })}
            >
              {t(`ext.trigger.${key}`)}
            </button>
          ))}
        </span>
      </Field>
      <Field label={t('ext.repo.minRole')}>
        <select
          className="ext-select"
          value={draft.minRole}
          disabled={disabled}
          onChange={(event) =>
            set({ minRole: event.target.value as ExternalSourceDraft['minRole'] })
          }
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </Field>
      {label && draft.triggers.label ? (
        <Field label={t('ext.repo.labelRoute')}>
          <select
            className="ext-select"
            value={route?.managerId ?? ''}
            disabled={disabled}
            onChange={(event) =>
              setRepo({
                labelRoutes: [
                  ...(repo.labelRoutes ?? []).filter((one) => one.labelId !== label),
                  ...(event.target.value
                    ? [{ labelId: label, managerId: event.target.value }]
                    : []),
                ],
              })
            }
          >
            <option value="">{t('ext.repo.labelAuto')}</option>
            {managers.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label={t('ext.repo.feedback')}>
        <Switch
          act="feedback"
          checked={repo.immediateFeedback !== false}
          label={t('ext.repo.feedback')}
          disabled={disabled}
          onChange={(next) => setRepo({ immediateFeedback: next })}
        />
        {repo.immediateFeedback !== false ? (
          <>
            <select
              className="ext-select"
              aria-label={t('ext.repo.feedbackLang')}
              value={repo.immediateFeedbackLanguage ?? 'follow-ui'}
              disabled={disabled}
              onChange={(event) =>
                setRepo({
                  immediateFeedbackLanguage: event.target.value as NonNullable<
                    typeof repo.immediateFeedbackLanguage
                  >,
                })
              }
            >
              {(['follow-ui', 'zh-CN', 'en'] as const).map((one) => (
                <option key={one} value={one}>
                  {t(`ext.lang.${one}`)}
                </option>
              ))}
            </select>
            <span className="dim">{t('ext.repo.delay', { n: draft.interval })}</span>
          </>
        ) : null}
      </Field>
      <Field label={t('ext.repo.poll')}>
        <select
          className="ext-select"
          value={repo.pollIdentity ?? ''}
          disabled={disabled}
          onChange={(event) => setRepo({ pollIdentity: event.target.value || null })}
        >
          <option value="">{t('ext.repo.pollAuto')}</option>
          {pollChoices.map((one) => (
            <option key={one.identityId} value={one.identityId}>
              {one.login}
            </option>
          ))}
        </select>
        <select
          className="ext-select"
          aria-label={t('ext.repo.interval')}
          value={draft.interval}
          disabled={disabled}
          onChange={(event) => set({ interval: Number(event.target.value) })}
        >
          {[...new Set([...INTERVALS, draft.interval])].map((one) => (
            <option key={one} value={one}>
              {t('ext.repo.every', { n: one })}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('ext.repo.root')}>
        <input
          className="req-input mono ext-input"
          value={repo.localRoot}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setRepo({ localRoot: event.target.value })}
        />
      </Field>
      <Field label={t('ext.repo.base')}>
        <input
          className="req-input mono ext-input"
          value={repo.allowedBase.join(', ')}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) =>
            setRepo({
              allowedBase: event.target.value
                .split(',')
                .map((one) => one.trim())
                .filter(Boolean),
            })
          }
        />
      </Field>
      <Field label={t('ext.repo.write')}>
        <span className="ext-chips">
          {(['comment', 'draftPr', 'status'] as const).map((key) => (
            <button
              type="button"
              key={key}
              className="ext-chip"
              data-write={key}
              aria-pressed={draft.writePolicy[key]}
              disabled={disabled}
              onClick={() =>
                set({ writePolicy: { ...draft.writePolicy, [key]: !draft.writePolicy[key] } })
              }
            >
              {t(`ext.write.${key}`)}
            </button>
          ))}
        </span>
      </Field>
      <Field label={t('ext.repo.autoNotify')}>
        <Switch
          act="auto-notify"
          checked={draft.unattended?.autoNotify === true}
          label={t('ext.repo.autoNotify')}
          disabled={disabled}
          onChange={(next) => set({ unattended: { autoNotify: next } })}
        />
      </Field>
      {dirty || act.error ? (
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
            className="btn ghost"
            data-act="source-reset"
            disabled={act.busy}
            onClick={() => {
              setDraft(JSON.parse(base) as ExternalSourceDraft)
              setPreview(null)
              act.setError('')
            }}
          >
            {t('ext.cancel')}
          </button>
          <button
            type="button"
            className="btn"
            data-act="source-preview"
            disabled={disabled || !dirty}
            onClick={() => void runPreview()}
          >
            {t('ext.preview')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-act="source-save"
            disabled={disabled || !dirty || !repo.localRoot.trim()}
            onClick={() => void save()}
          >
            {t('ext.save')}
          </button>
        </div>
      ) : null}
      {preview ? <PreviewResult value={preview} /> : null}
      <Readiness
        key={`${status.source.sourceId}/${changed}/${online}/${writable}`}
        deviceId={device.id}
        status={status}
        canCheck={online && writable}
      />
      <Coverage status={status} />
    </div>
  )
}

function Readiness({
  deviceId,
  status,
  canCheck,
}: {
  deviceId: string
  status: ExternalSourceStatus
  canCheck: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const check = useRun()
  const [manual, setManual] = useState<{
    snapshot: ExternalSourceStatus
    result: Pick<ExternalSourceStatus, 'readiness' | 'agentGhIdentity'>
  }>()
  const result = manual?.snapshot === status ? manual.result : undefined
  const readiness = result?.readiness
    ? { ...result.readiness, notify: status.readiness?.notify ?? result.readiness.notify }
    : status.readiness
  const agent = result ? result.agentGhIdentity : status.agentGhIdentity
  const recheck = async () => {
    const updated = await check.run(() =>
      channel.command('external.source.check', { deviceId, sourceId: status.source.sourceId }),
    )
    if (updated) setManual({ snapshot: status, result: updated })
  }
  return (
    <div className="ext-sub" data-ext-readiness>
      <div className="ext-sub-head">
        <span>{t('ext.ready')}</span>
        <span className="grow" />
        <button
          type="button"
          className="ibtn"
          data-act="source-check"
          title={t('ext.ready.check')}
          aria-label={t('ext.ready.check')}
          disabled={check.busy || !canCheck}
          onClick={() => void recheck()}
        >
          <Icon name="reload" small />
        </button>
      </div>
      {agent?.isOwner ? (
        <div className="devp-note err" data-agent-owner>
          {t('ext.ready.agentOwner', { login: agent.login })}
        </div>
      ) : null}
      {check.error ? (
        <div className="devp-note err" role="alert">
          {check.error}
        </div>
      ) : null}
      <ul className="ext-ready-list">
        {READINESS_AREAS.map((area) => {
          const part = readiness?.[area]
          return (
            <li key={area} data-area={area}>
              <span className="ext-ready-area">
                <Dot
                  tone={readinessTone[part?.state ?? 'unverified']}
                  label={t(`ext.ready.state.${part?.state ?? 'unverified'}`)}
                />
                {t(`ext.ready.${area}`)}
              </span>
              <ul className="ext-diags">
                {(part?.diagnostics ?? []).map((item, index) => (
                  <Diagnostic
                    key={`${item.check}:${item.code}:${item.recovery?.managerId ?? index}`}
                    item={item}
                    deviceId={deviceId}
                    canCheck={canCheck}
                  />
                ))}
              </ul>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Coverage({ status }: { status: ExternalSourceStatus }) {
  const t = useT()
  const runtime = status.runtime
  if (!status.coverage.length && !runtime) return null
  return (
    <div className="ext-sub" data-ext-coverage>
      <div className="ext-sub-head">
        <span>{t('ext.coverage')}</span>
        {runtime?.lastSuccessAt ? (
          <span className="dim">
            {t('ext.coverage.last')} <Stamp at={runtime.lastSuccessAt * 1000} />
          </span>
        ) : null}
        {runtime?.nextAttemptAt ? (
          <span className="dim">
            {t('ext.coverage.next')} <Stamp at={runtime.nextAttemptAt * 1000} />
          </span>
        ) : null}
        {runtime?.backlog.limited ? (
          <span className="pill wait">
            {t('ext.coverage.limited', { n: runtime.backlog.limited })}
          </span>
        ) : null}
      </div>
      <ul className="ext-diags">
        {status.coverage.map((one) => (
          <li key={one.stream} className="ext-diag" data-stream={one.stream}>
            <Dot tone={one.gap ? 'wait' : 'ok'} label={one.gap ? t('ext.coverage.gap') : 'ok'} />
            <span className="mono">{one.stream}</span>
            {one.coveredThrough ? <Stamp className="dim" at={one.coveredThrough * 1000} /> : null}
            {one.gap ? (
              <span className="dim ell">
                {t('ext.coverage.gapRange')} <Stamp at={one.gap.from * 1000} /> –{' '}
                <Stamp at={one.gap.to * 1000} /> · {one.gap.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
