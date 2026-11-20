// 无人值守页 ③ 经理分配：每位经理一行——用哪个 GitHub 身份、接哪些仓库、是否给经理和工作线注入这个身份的凭据。
// 同一仓库上同一身份只能分给一位经理（当场标出，不让保存）；身份对所接仓库缺写权限只提示，不拦。
// 经理设置里也用同一行（AssignmentRow）。
import type { DeviceView, ExternalIdentityRepository, ExternalManagerAssignment } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { type ManagerChoice, useExternalDevice, useIdentityDetails, useRun } from './data.ts'
import {
  assignmentConflicts,
  type IdentityHead,
  operationId,
  repoLabel,
  writeMissing,
} from './model.ts'
import { Switch } from './parts.tsx'

export interface RepoChoice {
  repoId: string
  label: string
}

const empty = (managerId: string): ExternalManagerAssignment => ({
  managerId,
  identityId: null,
  repoIds: [],
  injectCredentials: true,
  revision: 0,
})

export function AssignmentRow({
  deviceId,
  manager,
  assignment,
  all,
  identities,
  repos,
  repositories,
  disabled,
  showName = true,
}: {
  deviceId: string
  manager: ManagerChoice
  assignment: ExternalManagerAssignment | undefined
  all: readonly ExternalManagerAssignment[]
  identities: readonly IdentityHead[]
  repos: readonly RepoChoice[]
  repositories: readonly ExternalIdentityRepository[]
  disabled: boolean
  showName?: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const current = assignment ?? empty(manager.id)
  const [draft, setDraft] = useState(current)
  const act = useRun()
  const revision = current.revision
  // 设备上的版本变了（别处改过、保存成功）：以设备为准
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟版本走
  useEffect(() => setDraft(current), [revision])
  const inject = draft.injectCredentials !== false
  const dirty =
    draft.identityId !== current.identityId ||
    inject !== (current.injectCredentials !== false) ||
    [...draft.repoIds].sort().join() !== [...current.repoIds].sort().join()
  const conflicts = assignmentConflicts(draft, all)
  const missing = writeMissing(draft, repositories)
  const loginOf = (identityId: string | null) =>
    identities.find((one) => one.identityId === identityId)?.login ?? identityId ?? ''
  const labelOf = (repoId: string) => repos.find((one) => one.repoId === repoId)?.label ?? repoId
  const save = () =>
    act.run(() =>
      channel.command('external.manager.assignment.set', {
        deviceId,
        managerId: manager.id,
        identityId: draft.identityId,
        repoIds: draft.identityId ? draft.repoIds : [],
        injectCredentials: inject,
        expectedRevision: revision,
        operationId: operationId(),
      }),
    )
  return (
    <div className="ext-assign" data-assign={manager.id}>
      <div className="ext-row">
        {showName ? <b className="ext-row-name ell">{manager.name}</b> : null}
        <select
          className="ext-select"
          aria-label={t('ext.assign.identity')}
          value={draft.identityId ?? ''}
          disabled={disabled}
          onChange={(event) =>
            setDraft({
              ...draft,
              identityId: event.target.value || null,
              repoIds: event.target.value ? draft.repoIds : [],
            })
          }
        >
          <option value="">{t('ext.assign.noIdentity')}</option>
          {identities.map((one) => (
            <option key={one.identityId} value={one.identityId}>
              {one.login}
            </option>
          ))}
        </select>
        {draft.identityId ? (
          <>
            <span className="ext-chips">
              {repos.map((repo) => (
                <button
                  type="button"
                  key={repo.repoId}
                  className="ext-chip"
                  data-repo={repo.repoId}
                  data-conflict={conflicts.includes(repo.repoId) || undefined}
                  aria-pressed={draft.repoIds.includes(repo.repoId)}
                  disabled={disabled || !draft.identityId}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      repoIds: draft.repoIds.includes(repo.repoId)
                        ? draft.repoIds.filter((one) => one !== repo.repoId)
                        : [...draft.repoIds, repo.repoId],
                    })
                  }
                >
                  {repo.label}
                </button>
              ))}
            </span>
            <span className="grow" />
            <span className="ext-inject" title={t('ext.assign.injectNote')}>
              <span className="dim">{t('ext.assign.inject')}</span>
              <Switch
                act="inject"
                checked={inject}
                label={t('ext.assign.inject')}
                disabled={disabled || !draft.identityId}
                onChange={(next) => setDraft({ ...draft, injectCredentials: next })}
              />
            </span>
          </>
        ) : (
          <span className="grow" />
        )}
        {dirty ? (
          <button
            type="button"
            className="btn primary"
            data-act="assign-save"
            disabled={disabled || act.busy || conflicts.length > 0}
            onClick={() => void save()}
          >
            {t('ext.save')}
          </button>
        ) : null}
      </div>
      {conflicts.length ? (
        <div className="devp-note err" data-assign-conflict>
          {t('ext.assign.conflict', {
            login: loginOf(draft.identityId),
            repos: conflicts.map(labelOf).join(', '),
          })}
        </div>
      ) : null}
      {missing.length ? (
        <div className="devp-note" data-assign-missing>
          {t('ext.assign.writeMissing', {
            login: loginOf(draft.identityId),
            repos: missing.map((one) => `${one.owner}/${one.name}`).join(', '),
          })}
        </div>
      ) : null}
      {act.error ? (
        <div className="devp-note err" role="alert">
          {act.error}
        </div>
      ) : null}
    </div>
  )
}

export function Assignments({
  device,
  managers,
  assignments,
  identities,
  repos,
  repositories,
}: {
  device: DeviceView
  managers: ManagerChoice[]
  assignments: readonly ExternalManagerAssignment[] | null
  identities: readonly IdentityHead[]
  repos: readonly RepoChoice[]
  repositories: readonly ExternalIdentityRepository[]
}) {
  const t = useT()
  return (
    <section className="ext-block" data-ext-assignments>
      <div className="ext-block-head">
        <h3>{t('ext.assign')}</h3>
      </div>
      {assignments === null ? (
        <div className="ext-empty">{t('ext.loading')}</div>
      ) : managers.length === 0 ? (
        <div className="ext-empty">{t('ext.assign.noManager')}</div>
      ) : (
        <div className="ext-list">
          {managers.map((manager) => (
            <AssignmentRow
              key={manager.id}
              deviceId={device.id}
              manager={manager}
              assignment={assignments.find((one) => one.managerId === manager.id)}
              all={assignments}
              identities={identities}
              repos={repos}
              repositories={repositories}
              disabled={device.connection !== 'online'}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 经理设置里这位经理的 GitHub 身份、所接仓库与注入开关：和无人值守页③是同一行 */
export function ManagerGithub({ device, manager }: { device: DeviceView; manager: ManagerChoice }) {
  const t = useT()
  const view = useExternalDevice(device.id, device.externalSources === true)
  const online = device.connection === 'online'
  const configuration = view?.configuration?.value ?? null
  const { repositories } = useIdentityDetails(device.id, configuration?.revision ?? null, online)
  if (!device.externalSources || !configuration) return null
  const repos: RepoChoice[] = (view?.sources.value ?? []).flatMap((status) =>
    status.source.repos.map((repo) => ({ repoId: repo.repoId, label: repoLabel(repo) })),
  )
  return (
    <div className="form-field ext-manager" data-manager-github>
      <span>{t('ext.manager.github')}</span>
      <AssignmentRow
        deviceId={device.id}
        manager={manager}
        assignment={configuration.assignments.find((one) => one.managerId === manager.id)}
        all={configuration.assignments}
        identities={configuration.identities}
        repos={repos}
        repositories={repositories}
        disabled={!online}
        showName={false}
      />
    </div>
  )
}
