import {
  type Commands,
  type ExternalConfiguration,
  type ExternalIdentityRepository,
  type ExternalLabelRoute,
  type ExternalRepo,
  type ExternalSourceDraft,
  type ExternalSourceStatus,
  externalSourceDraft,
  type ManagerView,
} from '@litch/core'
import { useEffect, useId, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { ExternalDiagnostics, ExternalDialog, ExternalLink } from './ExternalControls.tsx'
import { CsvField } from './ExternalCsvField.tsx'
import { draftReady } from './external-source-form.ts'
import { externalOperationId } from './external-view.ts'

const triggers = ['mention', 'assignment', 'reviewRequest', 'label'] as const
const modes = ['triage', 'write', 'maintain', 'admin'] as const
const writes = ['comment', 'draftPr', 'status'] as const

function fromRepository(repo: ExternalIdentityRepository): ExternalSourceDraft | null {
  const grant = repo.grants.find((row) => row.read)
  if (!grant) return null
  return {
    sourceId: `github-${repo.repoId}`,
    provider: 'github',
    enabled: false,
    credentialRef: grant.credentialRef,
    botUserId: grant.botUserId,
    triggers: {
      mention: true,
      assignment: true,
      reviewRequest: true,
      label: true,
      labelIds: repo.defaultLabelId ? [repo.defaultLabelId] : [],
    },
    minRole: 'triage',
    writePolicy: { comment: false, draftPr: false, status: false, managedPush: false },
    interval: 120,
    routes: [],
    unattended: { autoNotify: false },
    repos: [
      {
        repoId: repo.repoId,
        owner: repo.owner,
        name: repo.name,
        url: repo.url,
        localRoot: '',
        allowedBase: [repo.defaultBranch],
        headNamespace: 'litch/',
        pollIdentity: null,
        labelRoutes: [],
      },
    ],
  }
}

export function ExternalSourceWizard({
  deviceId,
  existing,
  sources,
  managers,
  configuration,
  online,
  close,
  saved,
}: {
  deviceId: string
  existing: ExternalSourceStatus | null
  sources: ExternalSourceStatus[]
  managers: ManagerView[]
  configuration: ExternalConfiguration | null
  online: boolean
  close(): void
  saved(result: ExternalSourceStatus): void
}) {
  const t = useT()
  const { channel } = useServices()
  const baseId = useId()
  const [draft, setDraft] = useState(() => (existing ? externalSourceDraft(existing.source) : null))
  const [repos, setRepos] = useState<ExternalIdentityRepository[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [preview, setPreview] = useState<Commands['external.source.preview']['result']>()
  const [saveId, setSaveId] = useState(externalOperationId)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const fixed = existing?.source.repos[0]?.repoId
  const repo = draft?.repos[0]
  const assigned =
    configuration?.assignments.filter((row) => repo && row.repoIds.includes(repo.repoId)) ?? []
  const targets = managers.filter((manager) =>
    assigned.some((assignment) => assignment.managerId === manager.id),
  )
  const choices = repos.filter(
    (one) =>
      one.grants.some((grant) => grant.read) &&
      !sources.some(
        ({ source }) =>
          source.sourceId !== existing?.source.sourceId &&
          source.repos.some((entry) => entry.repoId === one.repoId),
      ),
  )
  const metadata = repos.find((one) => one.repoId === repo?.repoId)

  useEffect(() => {
    if (!online) return
    let live = true
    void channel
      .command('external.identity.repositories', { deviceId, ...(fixed ? { repoId: fixed } : {}) })
      .then(
        (page) => {
          if (live) {
            setRepos(page.repositories)
            setCursor(page.nextCursor)
          }
        },
        (error: unknown) => {
          if (live) setFailure(error)
        },
      )
    return () => {
      live = false
    }
  }, [channel, deviceId, fixed, online])

  const update = (patch: Partial<ExternalSourceDraft>) => {
    setDraft((prior) => (prior ? { ...prior, ...patch } : prior))
    setPreview(undefined)
    setSaveId(externalOperationId())
  }
  const patchRepo = (patch: Partial<ExternalRepo>) => {
    if (repo) update({ repos: [{ ...repo, ...patch }] })
  }
  const run = async (work: () => Promise<void>) => {
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
  const more = () =>
    run(async () => {
      if (!cursor) return
      const page = await channel.command('external.identity.repositories', { deviceId, cursor })
      if (page.nextCursor === cursor) throw new Error('Invalid repository cursor')
      setRepos([
        ...new Map([...repos, ...page.repositories].map((one) => [one.repoId, one])).values(),
      ])
      setCursor(page.nextCursor)
    })
  const wire = () =>
    draft
      ? {
          ...draft,
          routes: [],
          writePolicy: { ...draft.writePolicy, managedPush: false },
        }
      : null
  const doPreview = () =>
    run(async () => {
      const source = wire()
      if (source) setPreview(await channel.command('external.source.preview', { deviceId, source }))
    })
  const save = () =>
    run(async () => {
      const source = wire()
      if (!source) return
      const result = await channel.command('external.source.upsert', {
        deviceId,
        source,
        expectedRevision: existing?.source.revision ?? 0,
        operationId: saveId,
      })
      saved(result)
    })

  return (
    <ExternalDialog
      label={t(existing ? 'external.editRepo' : 'external.addRepo')}
      close={() => {
        if (!busy) close()
      }}
    >
      <div className="external-stack" data-source-wizard data-step={step}>
        <div className="seg external-segments">
          {(['repository', 'rulesAndRouting', 'preview'] as const).map((key, index) => (
            <button
              key={key}
              type="button"
              aria-pressed={step === index}
              disabled={busy || index > step}
              onClick={() => setStep(index)}
            >
              {index + 1}. {t(`external.${key}`)}
            </button>
          ))}
        </div>
        <fieldset className="external-stack external-bare" disabled={busy || !online}>
          {step === 0 ? (
            <>
              {fixed && repo ? (
                <div>
                  <ExternalLink url={repo.url}>
                    {repo.owner}/{repo.name}
                  </ExternalLink>
                  <span className="dim"> · {repo.repoId}</span>
                </div>
              ) : (
                <label className="external-field">
                  {t('external.repository')}
                  <select
                    value={repo?.repoId ?? ''}
                    onChange={(event) => {
                      const choice = choices.find((row) => row.repoId === event.target.value)
                      setDraft(choice ? fromRepository(choice) : null)
                      setPreview(undefined)
                      setSaveId(externalOperationId())
                    }}
                  >
                    <option value="">{t('external.pickRepo')}</option>
                    {choices.map((one) => (
                      <option key={one.repoId} value={one.repoId}>
                        {one.owner}/{one.name} · {one.repoId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {cursor && !fixed ? (
                <button className="mini external-start" type="button" onClick={() => void more()}>
                  {t('external.more')}
                </button>
              ) : null}
              {repo ? (
                <div className="external-grid">
                  <label className="external-field">
                    {t('external.pollIdentity')}
                    <select
                      value={repo.pollIdentity ?? ''}
                      onChange={(event) => {
                        const id = event.target.value
                        const grant = metadata?.grants.find(
                          (one) => one.read && (!id || one.identityId === id),
                        )
                        if (grant)
                          update({
                            credentialRef: grant.credentialRef,
                            botUserId: grant.botUserId,
                            repos: [{ ...repo, pollIdentity: id || null }],
                          })
                      }}
                    >
                      <option value="">{t('external.pollAuto')}</option>
                      {repo.pollIdentity &&
                      !metadata?.grants.some(
                        (one) => one.identityId === repo.pollIdentity && one.read,
                      ) ? (
                        <option value={repo.pollIdentity}>{repo.pollIdentity}</option>
                      ) : null}
                      {metadata?.grants
                        .filter((one) => one.read)
                        .map((one) => (
                          <option key={one.identityId} value={one.identityId}>
                            {configuration?.identities.find(
                              (identity) => identity.identityId === one.identityId,
                            )?.login ?? one.identityId}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="external-field">
                    {t('external.localRoot')}
                    <input
                      value={repo.localRoot}
                      onChange={(event) => patchRepo({ localRoot: event.target.value })}
                    />
                  </label>
                  <label className="external-field" htmlFor={baseId}>
                    {t('external.allowedBase')}
                    <CsvField
                      id={baseId}
                      values={repo.allowedBase}
                      update={(allowedBase) => patchRepo({ allowedBase })}
                    />
                  </label>
                  <label className="external-field">
                    {t('external.headNamespace')}
                    <input
                      value={repo.headNamespace}
                      onChange={(event) => patchRepo({ headNamespace: event.target.value })}
                    />
                  </label>
                </div>
              ) : !fixed && !choices.length ? (
                <p className="external-note">{t('external.noRepoChoices')}</p>
              ) : null}
            </>
          ) : step === 1 && draft && repo ? (
            <>
              <div className="external-wrap">
                {triggers.map((key) => (
                  <label className="external-choice" key={key}>
                    <input
                      type="checkbox"
                      checked={draft.triggers[key]}
                      onChange={(event) =>
                        update({ triggers: { ...draft.triggers, [key]: event.target.checked } })
                      }
                    />
                    {t(`external.trigger.${key}`)}
                  </label>
                ))}
              </div>
              <div className="external-grid">
                <label className="external-field">
                  {t('external.minRole')}
                  <select
                    value={draft.minRole}
                    onChange={(event) =>
                      update({ minRole: event.target.value as ExternalSourceDraft['minRole'] })
                    }
                  >
                    {modes.map((value) => (
                      <option value={value} key={value}>
                        {t(`external.role.${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="external-field">
                  {t('external.interval')}
                  <input
                    type="number"
                    min={1}
                    value={Number.isNaN(draft.interval) ? '' : draft.interval}
                    onChange={(event) => update({ interval: event.target.valueAsNumber })}
                  />
                </label>
              </div>
              {draft.triggers.label ? (
                <LabelRoutes
                  routes={repo.labelRoutes ?? []}
                  managers={targets}
                  update={(labelRoutes) => patchRepo({ labelRoutes })}
                />
              ) : null}
              <div className="external-panel external-stack">
                <label className="external-choice">
                  <input
                    type="checkbox"
                    checked={repo.immediateFeedback !== false}
                    onChange={(event) => patchRepo({ immediateFeedback: event.target.checked })}
                  />
                  {t('external.immediateFeedback')}
                </label>
                <p className="external-note">
                  {t('external.immediateFeedbackNote', {
                    seconds: Number.isSafeInteger(draft.interval) ? draft.interval : '–',
                  })}
                </p>
                <label className="external-field">
                  {t('external.immediateFeedbackLanguage')}
                  <select
                    value={repo.immediateFeedbackLanguage ?? 'follow-ui'}
                    disabled={repo.immediateFeedback === false}
                    onChange={(event) =>
                      patchRepo({
                        immediateFeedbackLanguage: event.target.value as NonNullable<
                          ExternalRepo['immediateFeedbackLanguage']
                        >,
                      })
                    }
                  >
                    <option value="follow-ui">{t('external.ackLanguage.follow-ui')}</option>
                    <option value="zh-CN">{t('external.ackLanguage.zh-CN')}</option>
                    <option value="en">{t('external.ackLanguage.en')}</option>
                  </select>
                </label>
              </div>
              <div className="external-stack">
                <h3>{t('external.permission')}</h3>
                {writes.map((key) => (
                  <label className="external-choice" key={key}>
                    <input
                      type="checkbox"
                      checked={draft.writePolicy[key]}
                      onChange={(event) =>
                        update({
                          writePolicy: { ...draft.writePolicy, [key]: event.target.checked },
                        })
                      }
                    />
                    {t(`external.write.${key}`)}
                  </label>
                ))}
              </div>
              <section className="external-panel external-stack" data-route-preview>
                <h3>{t('external.rulePreview')}</h3>
                {assigned.length ? (
                  assigned.map((assignment) => (
                    <div className="external-row" key={assignment.managerId}>
                      <span className="grow">
                        @
                        {configuration?.identities.find(
                          (one) => one.identityId === assignment.identityId,
                        )?.login ?? assignment.identityId}
                      </span>
                      <span>
                        {t('external.previewTarget', {
                          manager:
                            targets.find((one) => one.id === assignment.managerId)?.name ||
                            assignment.managerId,
                        })}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>{t('external.previewNoTarget')}</p>
                )}
              </section>
            </>
          ) : (
            <>
              <button
                type="button"
                className="mini external-button external-start"
                onClick={() => void doPreview()}
              >
                <Icon name="clock" small />
                {t('external.preview')}
              </button>
              {preview ? (
                <div className="external-stack" data-source-preview>
                  {preview.matches.length ? (
                    <ul className="external-list">
                      {preview.matches.map((row) => (
                        <li className="external-row" key={row.eventKey}>
                          <ExternalLink url={row.eventUrl}>
                            #{row.subject.number} · {row.kind}
                          </ExternalLink>
                          <span className="pill mute">
                            {t(
                              row.status === 'blocked'
                                ? 'external.previewBlocked'
                                : 'external.previewPass',
                            )}
                          </span>
                          <span className="dim">{row.reason}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t('external.previewEmpty')}</p>
                  )}
                  {preview.diagnostics.some((item) => item.state !== 'ok') ? (
                    <p>{t('external.previewIncomplete')}</p>
                  ) : null}
                  <ExternalDiagnostics items={preview.diagnostics} />
                </div>
              ) : (
                <p className="external-note">{t('external.previewNeeded')}</p>
              )}
            </>
          )}
        </fieldset>
        {failure ? (
          <p className="err" role="alert">
            {whyNot(failure, t)}
          </p>
        ) : null}
        <div className="external-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={busy}
            onClick={step > 0 ? () => setStep(step - 1) : close}
          >
            {t(step > 0 ? 'external.back' : 'external.cancel')}
          </button>
          {step < 2 ? (
            <button
              className="btn"
              type="button"
              disabled={
                busy ||
                !online ||
                !draft ||
                (step === 0
                  ? !repo?.localRoot.trim() || !repo.allowedBase.length
                  : !draftReady(draft))
              }
              onClick={() => setStep(step + 1)}
            >
              {t('external.next')}
            </button>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={busy || !online || !preview}
              onClick={() => void save()}
            >
              {t('external.save')}
            </button>
          )}
        </div>
      </div>
    </ExternalDialog>
  )
}

function LabelRoutes({
  routes,
  managers,
  update,
}: {
  routes: ExternalLabelRoute[]
  managers: ManagerView[]
  update(value: ExternalLabelRoute[]): void
}) {
  const t = useT()
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')
  const fresh = /^[1-9]\d*$/u.test(label) && !routes.some((route) => route.labelId === label)
  return (
    <section className="external-panel external-stack">
      <h3>{t('external.labelRoutes')}</h3>
      {managers.length === 1 ? (
        <p className="external-note">
          {t('external.defaultLabel', { name: managers[0]?.name || managers[0]?.id || '' })}
        </p>
      ) : null}
      {routes.map((route) => (
        <div className="external-row" key={route.labelId}>
          <span className="grow">
            {route.labelId} →{' '}
            {managers.find((manager) => manager.id === route.managerId)?.name || route.managerId}
          </span>
          <button
            type="button"
            className="ibtn"
            aria-label={t('external.routeRemove')}
            onClick={() => update(routes.filter((one) => one.labelId !== route.labelId))}
          >
            <Icon name="trash" small />
          </button>
        </div>
      ))}
      {managers.length ? (
        <div className="external-row">
          <input
            aria-label={t('external.labelId')}
            inputMode="numeric"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('external.labelId')}
          />
          <select
            aria-label={t('external.routeManager')}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">{t('external.routeManagerEmpty')}</option>
            {managers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.name || manager.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mini"
            disabled={!fresh || !target}
            onClick={() => {
              update([...routes, { labelId: label, managerId: target }])
              setLabel('')
            }}
          >
            {t('external.routeAdd')}
          </button>
        </div>
      ) : (
        <p className="external-note">{t('external.previewNoTarget')}</p>
      )}
    </section>
  )
}
