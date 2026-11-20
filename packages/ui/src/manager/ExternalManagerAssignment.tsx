import type {
  ExternalManagerAssignment as Assignment,
  ExternalIdentityRepository,
  ManagerView,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { ExternalWarning } from '../devices/ExternalControls.tsx'
import { externalOperationId, useExternalTopic } from '../devices/external-view.ts'

export function ExternalManagerAssignment({ manager }: { manager: ManagerView }) {
  const t = useT()
  const { channel } = useServices()
  const { deviceId, id: managerId } = manager
  const view = useExternalTopic({ kind: 'externalDevice', deviceId })
  const configuration = view?.configuration?.value
  const sources = view?.sources.value ?? []
  const [state, setState] = useState<Assignment | null>(null)
  const [draft, setDraft] = useState<Assignment | null>(null)
  const [repoGrants, setRepoGrants] = useState<ExternalIdentityRepository[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const canEdit = view?.sources.online === true && manager.status === 'active'
  useEffect(() => {
    if (!canEdit) return
    let active = true
    void channel.command('external.manager.assignment.get', { deviceId, managerId }).then(
      (result) => {
        if (active) {
          setState(result)
          setDraft(null)
        }
      },
      (cause: unknown) => {
        if (active) setError(cause)
      },
    )
    return () => {
      active = false
    }
  }, [canEdit, channel, deviceId, managerId])
  const form = draft ?? state
  const selectedIdentity = form?.identityId
  const selectedRepos = form?.repoIds.join(',') ?? ''
  const configurationRevision = configuration?.revision
  useEffect(() => {
    setRepoGrants(null)
    if (!canEdit || !selectedIdentity || !selectedRepos || configurationRevision === undefined)
      return
    let active = true
    void Promise.all(
      selectedRepos.split(',').map((repoId) =>
        channel.command('external.identity.repositories', {
          deviceId,
          identityId: selectedIdentity,
          repoId,
        }),
      ),
    ).then(
      (pages) => {
        if (active) setRepoGrants(pages.flatMap((page) => page.repositories))
      },
      (cause: unknown) => {
        if (active) setError(cause)
      },
    )
    return () => {
      active = false
    }
  }, [canEdit, channel, configurationRevision, deviceId, selectedIdentity, selectedRepos])
  const save = async () => {
    if (!draft || !state) return
    setBusy(true)
    setError(undefined)
    const { revision: _revision, ...values } = draft
    try {
      const next = await channel.command('external.manager.assignment.set', {
        deviceId,
        ...values,
        expectedRevision: state.revision,
        operationId: externalOperationId(),
      })
      setState(next)
      setDraft(null)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }
  if (!form && !error) return null

  const identity = configuration?.identities.find((row) => row.identityId === form?.identityId)
  const allRepos = sources.flatMap(({ source }) => source.repos)
  const duplicate = (id: string) =>
    !!form?.identityId &&
    configuration?.assignments.some(
      (row) =>
        row.managerId !== managerId &&
        row.identityId === form.identityId &&
        row.repoIds.includes(id),
    )
  const warnings = allRepos.filter(
    (repo) =>
      form?.repoIds.includes(repo.repoId) &&
      repoGrants
        ?.find((one) => one.repoId === repo.repoId)
        ?.grants.some((grant) => grant.identityId === form.identityId && grant.write === 'missing'),
  )
  const injectionUnavailable =
    repoGrants !== null &&
    !repoGrants.some((repo) =>
      repo.grants.some((grant) => grant.identityId === selectedIdentity && grant.read),
    )
  const injectionHint = !selectedRepos
    ? t('external.injectionNeedsRepo')
    : injectionUnavailable
      ? t('external.useBotUnavailable')
      : undefined
  return (
    <section className="external-stack" data-external-assignment={managerId}>
      {form ? (
        <>
          <label className="form-field">
            {t('external.managerIdentity')}
            <select
              className="req-input"
              value={form.identityId ?? ''}
              disabled={!canEdit || busy}
              onChange={(event) =>
                setDraft({
                  ...form,
                  identityId: event.target.value || null,
                  repoIds: event.target.value ? form.repoIds : [],
                })
              }
            >
              <option value="">{t('external.noAssignedIdentity')}</option>
              {form.identityId && !identity ? (
                <option value={form.identityId}>{form.identityId}</option>
              ) : null}
              {configuration?.identities.map((row) => (
                <option value={row.identityId} key={row.identityId}>
                  @{row.login}
                </option>
              ))}
            </select>
          </label>
          {form.identityId ? (
            <>
              <fieldset className="external-stack external-bare" disabled={!canEdit || busy}>
                <legend>{t('external.managerRepos')}</legend>
                {allRepos.map((repo) => {
                  const picked = form.repoIds.includes(repo.repoId)
                  const taken = duplicate(repo.repoId)
                  return (
                    <label
                      className="external-choice"
                      key={repo.repoId}
                      title={taken ? t('external.assignmentTaken') : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={picked}
                        disabled={!!taken && !picked}
                        onChange={(event) =>
                          setDraft({
                            ...form,
                            repoIds: event.target.checked
                              ? [...form.repoIds, repo.repoId]
                              : form.repoIds.filter((id) => id !== repo.repoId),
                          })
                        }
                      />
                      {repo.owner}/{repo.name}
                      {taken ? (
                        <span className="dim">· {t('external.assignmentTaken')}</span>
                      ) : null}
                    </label>
                  )
                })}
              </fieldset>
              <label className="external-choice" title={injectionHint}>
                <input
                  type="checkbox"
                  checked={form.injectCredentials !== false}
                  disabled={!canEdit || busy || !!injectionHint}
                  onChange={(event) =>
                    setDraft({ ...form, injectCredentials: event.target.checked })
                  }
                />
                {t('external.useBot')}
              </label>
              <span className="dim">
                {form.injectCredentials !== false
                  ? (injectionHint ?? t('external.useBotOn'))
                  : t('external.useBotOff')}
              </span>
              {warnings.map((repo) => (
                <ExternalWarning key={repo.repoId}>
                  {t('external.addBotToRepo', {
                    bot: identity?.login ?? form.identityId ?? '',
                    repo: `${repo.owner}/${repo.name}`,
                  })}
                </ExternalWarning>
              ))}
            </>
          ) : null}
          {draft ? (
            <div className="external-actions">
              <button type="button" className="mini" disabled={busy} onClick={() => setDraft(null)}>
                {t('external.cancel')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!canEdit || busy || draft.repoIds.some(duplicate)}
                onClick={() => void save()}
              >
                {t('external.saveAssignment')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <span className="err" role="alert">
          {whyNot(error, t)}
        </span>
      ) : null}
    </section>
  )
}
