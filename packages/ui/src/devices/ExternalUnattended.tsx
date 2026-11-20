import {
  type Commands,
  type DeviceAutostartStatus,
  type DeviceView,
  type ExternalDeviceView,
  type ExternalReadinessArea,
  type ExternalSourceStatus,
  externalSourceDraft,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import {
  ExternalDiagnostics,
  ExternalDialog,
  ExternalStatus,
  ExternalWarning,
} from './ExternalControls.tsx'
import { externalOperationId, externalTime } from './external-view.ts'

const areas: ExternalReadinessArea[] = ['collect', 'notify', 'dispatch', 'write']

function AutostartDialog({
  status,
  online,
  close,
  submit,
}: {
  status: DeviceAutostartStatus
  online: boolean
  close(): void
  submit(flags: {
    takeover: boolean
    allowLinger: boolean
    confirmStop: boolean
    resumeAfterRestart: boolean
  }): void
}) {
  const t = useT()
  const enabling = status.state !== 'enabled' && status.state !== 'degraded'
  const takeoverNeeded = enabling && status.instance?.mode === 'manual'
  const stopNeeded = Boolean(status.instance && (!enabling || takeoverNeeded))
  const [takeover, setTakeover] = useState(false)
  const [allowLinger, setLinger] = useState(false)
  const [confirmStop, setStop] = useState(false)
  const [resumeAfterRestart, setResume] = useState(false)
  const title = t(enabling ? 'external.autostartEnable' : 'external.autostartDisable')

  return (
    <ExternalDialog label={title} close={close}>
      <div className="external-stack">
        {takeoverNeeded ? (
          <>
            <p className="external-note">{t('external.takeoverRequired')}</p>
            <label className="external-choice">
              <input
                type="checkbox"
                checked={takeover}
                onChange={(event) => setTakeover(event.target.checked)}
              />
              {t('external.takeover')}
            </label>
          </>
        ) : null}
        {enabling && status.serviceManager === 'systemd' && status.linger === 'disabled' ? (
          <label className="external-choice">
            <input
              type="checkbox"
              checked={allowLinger}
              onChange={(event) => setLinger(event.target.checked)}
            />
            {t('external.allowLinger')}
          </label>
        ) : null}
        {stopNeeded ? (
          <>
            {!takeoverNeeded ? (
              <label className="external-choice">
                <input
                  type="checkbox"
                  checked={confirmStop}
                  onChange={(event) => setStop(event.target.checked)}
                />
                {t('external.confirmStop')}
              </label>
            ) : null}
            <label className="external-choice">
              <input
                type="checkbox"
                checked={resumeAfterRestart}
                disabled={!takeover && !confirmStop}
                onChange={(event) => setResume(event.target.checked)}
              />
              {t('external.resumeAfterRestart')}
            </label>
          </>
        ) : null}
        <div className="external-actions">
          <button type="button" className="btn ghost" onClick={close}>
            {t('external.cancel')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!online || (takeoverNeeded ? !takeover : stopNeeded && !confirmStop)}
            onClick={() =>
              submit({
                takeover,
                allowLinger,
                confirmStop: takeover || confirmStop,
                resumeAfterRestart,
              })
            }
          >
            {title}
          </button>
        </div>
      </div>
    </ExternalDialog>
  )
}

export function ExternalUnattended({
  device,
  view,
}: {
  device: DeviceView
  view: ExternalDeviceView | undefined
}) {
  const { channel } = useServices()
  const t = useT()
  const status = view?.autostart.value
  const online = device.connection === 'online'
  const [asking, setAsking] = useState<DeviceAutostartStatus | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const last = status?.lastOperation
  const final = last?.operationId === waiting && last?.state !== 'pending' ? last : null

  useEffect(() => {
    if (final?.state === 'completed') setWaiting(null)
  }, [final?.state])

  const change = async ({
    takeover,
    allowLinger,
    ...flags
  }: {
    takeover: boolean
    allowLinger: boolean
    confirmStop: boolean
    resumeAfterRestart: boolean
  }) => {
    if (!asking) return
    const enabling = asking.state !== 'enabled' && asking.state !== 'degraded'
    const operationId = externalOperationId()
    const args = { deviceId: device.id, operationId, expectedRevision: asking.revision, ...flags }
    setAsking(null)
    setBusy(true)
    setFailure(undefined)
    setWaiting(null)
    try {
      const result = enabling
        ? await channel.command('external.autostart.enable', { ...args, takeover, allowLinger })
        : await channel.command('external.autostart.disable', args)
      if (result.state === 'accepted') setWaiting(result.operationId)
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="external-stack">
      <div className="external-row">
        <b>{t('external.autostart')}</b>
        {status ? (
          <span className={`pill ${status.state === 'enabled' ? 'ok' : 'mute'}`}>
            {t(`external.autostart.${status.state}`)}
          </span>
        ) : null}
        <span className="grow dim">
          {status?.requiresLogin ? t('external.loginRequired') : status?.serviceManager}
        </span>
        {status && status.state !== 'unsupported' ? (
          <button
            type="button"
            className="mini external-button"
            disabled={
              busy || !online || (!!waiting && !final) || status.lastOperation?.state === 'pending'
            }
            title={!online ? t('external.offline') : undefined}
            onClick={() => setAsking(status)}
          >
            <Icon name="tool" small />
            {t(
              status.state === 'enabled' || status.state === 'degraded'
                ? 'external.autostartDisable'
                : 'external.autostartEnable',
            )}
          </button>
        ) : null}
      </div>
      {view ? <ExternalStatus view={view.autostart} /> : null}
      {status?.repair ? <ExternalWarning>{t.said(status.repair.text)}</ExternalWarning> : null}
      {waiting && !final ? (
        <p className="external-note" role="status">
          {t('external.autostartAccepted')}
        </p>
      ) : null}
      {final?.state === 'failed' || status?.lastOperation?.state === 'failed' ? (
        <p className="err" role="alert">
          {t('external.autostartFailed')}
        </p>
      ) : null}
      {failure ? (
        <p className="err" role="alert">
          {whyNot(failure, t)}
        </p>
      ) : null}
      {asking ? (
        <AutostartDialog
          status={asking}
          online={online}
          close={() => setAsking(null)}
          submit={(flags) => void change(flags)}
        />
      ) : null}
      <ExternalStatus view={view?.sources} />
      {view?.sources.value?.map((entry) => (
        <SourceReadiness
          key={entry.source.sourceId}
          device={device}
          entry={entry}
          ownerId={view.owner.value?.userId}
        />
      ))}
      {view?.sources.value?.length === 0 && view.sources.online ? (
        <p className="external-note">{t('external.noSources')}</p>
      ) : null}
    </div>
  )
}

function SourceReadiness({
  device,
  entry,
  ownerId,
}: {
  device: DeviceView
  entry: ExternalSourceStatus
  ownerId: string | undefined
}) {
  const { channel } = useServices()
  const t = useT()
  const [local, setLocal] = useState<{
    revision: number
    result: Commands['external.source.check']['result']
  }>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const { source, runtime, coverage } = entry
  const check = local?.revision === source.revision ? local.result : null
  const readiness = check?.readiness ?? entry.readiness
  const identity = check?.agentGhIdentity ?? entry.agentGhIdentity
  const ackBlocked =
    source.repos.some((repo) => repo.immediateFeedback !== false) &&
    [...(readiness?.write.diagnostics ?? []), ...(check?.diagnostics ?? [])].some(
      (item) => item.check === 'immediateFeedbackComments' && item.state === 'blocked',
    )
  const online = device.connection === 'online'
  const autoNotify = source.unattended?.autoNotify ?? false
  const cannotNotify = !source.enabled
    ? t('external.collectionFirst')
    : readiness?.notify.state !== 'ok'
      ? t('external.notifyBlocked')
      : undefined
  const sourceArgs = { deviceId: device.id, sourceId: source.sourceId }
  const writeArgs = () => ({
    ...sourceArgs,
    operationId: externalOperationId(),
    expectedRevision: source.revision,
  })
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setFailure(undefined)
    try {
      await work()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  const time = (value: number) => externalTime(value, t.lang)
  const runtimeKey = runtime?.state ?? (source.enabled ? 'enabled' : 'paused')
  const calendar = [
    ['lastSuccess', runtime?.lastSuccessAt],
    ['lastAttempt', runtime?.lastAttemptAt],
    ['nextAttempt', runtime?.nextAttemptAt],
  ] as const

  return (
    <section className="external-panel external-stack" data-unattended-source={source.sourceId}>
      <div className="external-row">
        <b className="grow">{source.sourceId}</b>
        <span className={`pill ${runtimeKey === 'collecting' ? 'ok' : 'mute'}`}>
          {t(`external.runtime.${runtimeKey}`)}
        </span>
        <button
          type="button"
          className="mini external-button"
          disabled={!online || busy}
          title={!online ? t('external.offline') : undefined}
          onClick={() =>
            void act(() =>
              channel.command(
                source.enabled ? 'external.source.pause' : 'external.source.resume',
                writeArgs(),
              ),
            )
          }
        >
          <Icon name={source.enabled ? 'pause' : 'play'} small />
          {t(source.enabled ? 'external.pause' : 'external.resume')}
        </button>
      </div>
      <label
        className="external-choice"
        title={!online ? t('external.offline') : autoNotify ? undefined : cannotNotify}
      >
        <input
          type="checkbox"
          checked={autoNotify}
          disabled={!online || busy || (!autoNotify && !!cannotNotify)}
          onChange={(event) => {
            const enabled = event.target.checked
            void act(() =>
              channel
                .command('external.source.upsert', {
                  deviceId: device.id,
                  expectedRevision: source.revision,
                  operationId: externalOperationId(),
                  source: {
                    ...externalSourceDraft(source),
                    unattended: { ...source.unattended, autoNotify: enabled },
                  },
                })
                .then((settle) => {
                  if (settle.source.revision !== source.revision) setLocal(undefined)
                }),
            )
          }}
        />
        {t('external.autoNotify')}
      </label>
      {runtime ? (
        <div className="external-wrap external-note">
          {calendar.map(([kind, value]) =>
            value === undefined ? null : (
              <span key={kind}>
                {t(`external.${kind}`)} {time(value)}
              </span>
            ),
          )}
          {runtime.credentialState ? (
            <span className={runtime.credentialState === 'active' ? '' : 'err'}>
              {t(`external.credential.${runtime.credentialState}`)}
            </span>
          ) : null}
        </div>
      ) : null}
      {runtime?.backlog ? (
        <div className="external-wrap external-note">
          <b>{t('external.backlog', runtime.backlog)}</b>
          {runtime.backlog.oldestAt !== undefined ? (
            <span>
              {t('external.oldest')} {time(runtime.backlog.oldestAt)}
            </span>
          ) : null}
          {runtime.backlog.nextWakeAt !== undefined ? (
            <span>
              {t('external.nextWake')} {time(runtime.backlog.nextWakeAt)}
            </span>
          ) : null}
        </div>
      ) : null}
      {coverage.length ? (
        <ul className="external-list external-note">
          {coverage.map((row) => {
            const repo = source.repos.find((one) => one.repoId === row.repoId)
            return (
              <li className="external-wrap" key={`${row.repoId}:${row.stream}`}>
                <span>
                  {repo?.name ?? row.repoId} · {row.stream}
                </span>
                <span>
                  {row.coveredThrough === null
                    ? t('external.check.unverified')
                    : `${t('external.coveredThrough')} ${time(row.coveredThrough)} · ${t(
                        'external.lag',
                        {
                          n: Math.max(0, Math.floor(Date.now() / 1000) - row.coveredThrough),
                        },
                      )}`}
                </span>
                {row.backoffUntil ? (
                  <span>
                    {t('external.limitedUntil')} {time(row.backoffUntil)}
                  </span>
                ) : null}
                {row.gap ? (
                  <span className="err">
                    {t('external.gap')} {time(row.gap.from)}–{time(row.gap.to)} · {row.gap.reason}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="external-row">
        <h3 className="grow">{t('external.readiness')}</h3>
        <button
          type="button"
          className="mini external-button"
          disabled={!online || busy}
          title={!online ? t('external.offline') : undefined}
          onClick={() =>
            void act(async () =>
              setLocal({
                revision: source.revision,
                result: await channel.command('external.source.check', sourceArgs),
              }),
            )
          }
        >
          <Icon name="reload" small />
          {t('external.runCheck')}
        </button>
      </div>
      <div className="external-grid">
        {areas.map((area) => (
          <div className="external-stack" key={area}>
            <div className="external-row">
              <b>{t(`external.readiness.${area}`)}</b>
              <span className={`pill ${readiness?.[area].state === 'ok' ? 'ok' : 'mute'}`}>
                {t(`external.check.${readiness?.[area].state ?? 'unverified'}`)}
              </span>
            </div>
            <ExternalDiagnostics items={readiness?.[area].diagnostics ?? []} />
          </div>
        ))}
      </div>
      <ExternalDiagnostics items={check?.diagnostics ?? []} />
      {ackBlocked ? <ExternalWarning>{t('external.ackUnavailable')}</ExternalWarning> : null}
      <div className="external-row">
        <b>{t('external.agentGh')}</b>
        <span className="dim">
          {identity
            ? `@${identity.login} · ${identity.userId} · ${time(identity.checkedAt)}`
            : t('external.check.unverified')}
        </span>
      </div>
      {identity && (identity.isOwner || identity.userId === ownerId) ? (
        <ExternalWarning>{t('external.agentOwner')}</ExternalWarning>
      ) : null}
      {failure ? (
        <p className="err" role="alert">
          {whyNot(failure, t)}
        </p>
      ) : null}
    </section>
  )
}
