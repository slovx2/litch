// 无人值守页 ② 仓库：每个来源（一个仓库）一行，行上只放状态点、就绪四点、待分拣数、暂停/恢复和展开。
// 展开后是这个仓库的设置（RepoDetail）与就绪、覆盖；标题行的 + 打开添加仓库。
import type {
  DeviceView,
  ExternalAccess,
  ExternalIdentityRepository,
  ExternalSourceStatus,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Caret, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { AddRepo } from './AddRepo.tsx'
import { type ManagerChoice, useRun } from './data.ts'
import {
  allowed,
  type IdentityHead,
  operationId,
  readinessStates,
  repoLabel,
  sourceState,
} from './model.ts'
import { Dot, ExtLink, readinessTone, sourceTone } from './parts.tsx'
import { RepoDetail } from './RepoDetail.tsx'

function RepoRow({
  device,
  status,
  access,
  identities,
  repositories,
  managers,
}: {
  device: DeviceView
  status: ExternalSourceStatus
  access: ExternalAccess | undefined
  identities: IdentityHead[]
  repositories: ExternalIdentityRepository[]
  managers: ManagerChoice[]
}) {
  const t = useT()
  const { channel } = useServices()
  const [open, setOpen] = useState(false)
  const act = useRun()
  const { source } = status
  const repo = source.repos[0]
  const state = sourceState(status)
  const paused = state === 'paused'
  const online = device.connection === 'online'
  const canToggle = allowed(access, paused ? 'resumeSource' : 'pauseSource')
  const toggle = () =>
    act.run(() =>
      channel.command(paused ? 'external.source.resume' : 'external.source.pause', {
        deviceId: device.id,
        sourceId: source.sourceId,
        expectedRevision: source.revision,
        operationId: operationId(),
      }),
    )
  const pending = status.runtime?.backlog.pending ?? 0
  const name = repo ? repoLabel(repo) : source.sourceId
  return (
    <li className="ext-repo" data-source={source.sourceId} data-state={state} data-open={open}>
      <div className="ext-row">
        <Dot tone={sourceTone[state]} label={t(`ext.state.${state}`)} />
        <b className="ext-row-name ell">{name}</b>
        {repo ? <ExtLink url={repo.url} /> : null}
        <span className="ext-ready" data-ext-ready>
          {readinessStates(status.readiness).map(({ area, state: one }) => (
            <Dot
              key={area}
              tone={readinessTone[one]}
              label={`${t(`ext.ready.${area}`)} · ${t(`ext.ready.state.${one}`)}`}
            />
          ))}
        </span>
        {pending ? (
          <span className="pill wait" title={t('ext.repo.pending')}>
            {pending}
          </span>
        ) : null}
        <span className="grow" />
        {canToggle ? (
          <button
            type="button"
            className="ibtn"
            data-act={paused ? 'source-resume' : 'source-pause'}
            title={t(paused ? 'ext.repo.resume' : 'ext.repo.pause')}
            aria-label={t(paused ? 'ext.repo.resume' : 'ext.repo.pause')}
            disabled={!online || act.busy}
            onClick={() => void toggle()}
          >
            <Icon name={paused ? 'play' : 'pause'} small />
          </button>
        ) : null}
        <button
          type="button"
          className="ibtn"
          data-act="source-expand"
          aria-expanded={open}
          title={t(open ? 'ext.collapse' : 'ext.expand')}
          aria-label={t(open ? 'ext.collapse' : 'ext.expand')}
          onClick={() => setOpen(!open)}
        >
          <Caret />
        </button>
      </div>
      {act.error ? (
        <div className="devp-note err" role="alert">
          {act.error}
        </div>
      ) : null}
      {open ? (
        <RepoDetail
          device={device}
          writable={allowed(access, 'configure')}
          status={status}
          identities={identities}
          repositories={repositories}
          managers={managers}
        />
      ) : null}
    </li>
  )
}

export function Repos({
  device,
  sources,
  access,
  identities,
  repositories,
  managers,
  error,
}: {
  device: DeviceView
  sources: ExternalSourceStatus[] | null
  access: ExternalAccess | undefined
  identities: IdentityHead[]
  repositories: ExternalIdentityRepository[]
  managers: ManagerChoice[]
  error: string
}) {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const online = device.connection === 'online'
  const writable = online && allowed(access, 'configure')
  useEffect(() => {
    if (!writable) setAdding(false)
  }, [writable])
  return (
    <section className="ext-block" data-ext-repos>
      <div className="ext-block-head">
        <h3>{t('ext.repos')}</h3>
        <span className="grow" />
        <button
          type="button"
          className="ibtn"
          data-act="repo-add"
          title={t(identities.length ? 'ext.repo.add' : 'ext.repo.needIdentity')}
          aria-label={t('ext.repo.add')}
          disabled={!writable || !identities.length}
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" small />
        </button>
      </div>
      {sources === null ? (
        <div className="ext-empty">{error || t('ext.loading')}</div>
      ) : sources.length === 0 ? (
        <div className="ext-empty">{t('ext.repo.none')}</div>
      ) : (
        <ul className="ext-list">
          {sources.map((status) => (
            <RepoRow
              key={status.source.sourceId}
              device={device}
              status={status}
              access={access}
              identities={identities}
              repositories={repositories}
              managers={managers}
            />
          ))}
        </ul>
      )}
      {writable && adding ? (
        <AddRepo
          deviceId={device.id}
          repositories={repositories}
          identities={identities}
          taken={new Set((sources ?? []).flatMap((one) => one.source.repos.map((r) => r.repoId)))}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </section>
  )
}
