import {
  EXTERNAL_IDENTITY_OPTIONAL_SCOPES,
  EXTERNAL_IDENTITY_REQUIRED_SCOPES,
  EXTERNAL_IDENTITY_VERIFICATION_URL,
  type ExternalIdentityAuthorization,
  type ExternalIdentityLogin,
  type ExternalIdentityScope,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { openSystemLink } from '../side/browser/links.ts'
import {
  ExternalDialog,
  ExternalLink,
  ExternalTokenPrompt,
  ExternalWarning,
} from './ExternalControls.tsx'
import { externalOperationId, externalTime, useExternalTopic } from './external-view.ts'

type OptionalScope = (typeof EXTERNAL_IDENTITY_OPTIONAL_SCOPES)[number]

export function ExternalIdentityLoginDialog({
  deviceId,
  online,
  close,
}: {
  deviceId: string
  online: boolean
  close(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [selected, setSelected] = useState<OptionalScope[]>([])
  const [initial, setInitial] = useState<ExternalIdentityLogin>()
  const [paste, setPaste] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [copied, setCopied] = useState(false)
  const view = useExternalTopic(
    { kind: 'externalIdentityLogin', deviceId, loginId: initial?.loginId ?? '' },
    !!initial,
  )
  const data =
    view?.value && initial && view.value.revision >= initial.revision ? view.value : initial
  const pending =
    data?.state === 'waiting' || (data?.state === 'succeeded' && data.needsConfirmation)
  const pendingOwner = data?.state === 'succeeded' && data.needsConfirmation

  const run = async (
    work: () => Promise<ExternalIdentityLogin>,
    onResult?: (outcome: ExternalIdentityLogin) => void,
  ) => {
    setBusy(true)
    setFailure(undefined)
    setCopied(false)
    try {
      const outcome = await work()
      setInitial(outcome)
      onResult?.(outcome)
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  const start = () => {
    const scopes: ExternalIdentityScope[] = [...EXTERNAL_IDENTITY_REQUIRED_SCOPES, ...selected]
    void run(
      () =>
        channel.command('external.identity.add', {
          deviceId,
          operationId: externalOperationId(),
          scopes,
        }),
      (outcome) => {
        if (
          outcome.state === 'waiting' &&
          outcome.verificationUrl === EXTERNAL_IDENTITY_VERIFICATION_URL
        )
          openSystemLink(outcome.verificationUrl)
      },
    )
  }
  const dismiss = () => {
    if (busy) return
    if (pending && online && data) {
      void run(
        () =>
          channel.command('external.identity.login.cancel', {
            deviceId,
            loginId: data.loginId,
            operationId: externalOperationId(),
          }),
        close,
      )
    } else close()
  }
  const consent = () => {
    if (!pendingOwner || !data) return
    void run(() =>
      channel.command('external.identity.login.confirm', {
        deviceId,
        loginId: data.loginId,
        expectedRevision: data.revision,
        operationId: externalOperationId(),
      }),
    )
  }

  return (
    <>
      <ExternalDialog label={t('external.addIdentity')} close={dismiss}>
        <section className="external-stack" data-identity-auth={data?.state ?? 'choose'}>
          {!data ? (
            <>
              <fieldset className="external-bare external-stack" disabled={busy || !online}>
                <legend>{t('external.authScopes')}</legend>
                <div className="external-wrap">
                  {EXTERNAL_IDENTITY_REQUIRED_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="external-choice"
                      title={t('external.authLockedScope')}
                    >
                      <input type="checkbox" checked disabled />
                      {scope}
                    </label>
                  ))}
                </div>
                <div className="external-wrap">
                  {EXTERNAL_IDENTITY_OPTIONAL_SCOPES.map((scope) => (
                    <label key={scope} className="external-choice">
                      <input
                        type="checkbox"
                        checked={selected.includes(scope)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, scope]
                              : selected.filter((one) => one !== scope),
                          )
                        }
                      />
                      {scope}
                    </label>
                  ))}
                </div>
              </fieldset>
              <p>{t('external.authAppNote')}</p>
              <div className="external-row">
                <button className="btn" type="button" disabled={busy || !online} onClick={start}>
                  {t('external.authStart')}
                </button>
                <button
                  type="button"
                  className="mini"
                  disabled={busy || !online}
                  onClick={() =>
                    void run(() =>
                      channel.command('external.identity.import', {
                        deviceId,
                        operationId: externalOperationId(),
                      }),
                    )
                  }
                >
                  {t('external.authImport')}
                </button>
              </div>
              <details>
                <summary>{t('external.authAdvanced')}</summary>
                <button
                  type="button"
                  className="mini"
                  disabled={!online || busy}
                  onClick={() => setPaste(true)}
                >
                  {t('external.authPaste')}
                </button>
              </details>
            </>
          ) : data.state === 'waiting' ? (
            <>
              <p>{t('external.authWaitingNote')}</p>
              <div className="external-row">
                <output className="external-auth-code mono" aria-label={t('external.authCode')}>
                  {data.userCode}
                </output>
                <button
                  type="button"
                  className="mini external-button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(data.userCode)
                      .then(() => setCopied(true), setFailure)
                  }
                >
                  <Icon name="copy" small />
                  {t(copied ? 'external.authCopied' : 'external.authCopy')}
                </button>
              </div>
              <div className="external-wrap">
                <button
                  type="button"
                  className="mini"
                  onClick={() => openSystemLink(EXTERNAL_IDENTITY_VERIFICATION_URL)}
                >
                  {t('external.authOpenPage')}
                </button>
                <small className="dim">
                  {t('external.authExpiresAt', { time: externalTime(data.expiresAt, t.lang) })}
                </small>
              </div>
              <p className="external-note" role="status">
                {t('external.authState.waiting')}
              </p>
            </>
          ) : data.state === 'succeeded' ? (
            <>
              <AuthorizationProfile profile={data.result} />
              {pendingOwner ? (
                <ExternalWarning>{t('external.authOwnerConfirm')}</ExternalWarning>
              ) : (
                <p role="status" className="external-note">
                  {t('external.authState.succeeded')}
                </p>
              )}
            </>
          ) : (
            <p role="status" className="external-note">
              {t(`external.authState.${data.state}`)}
              {data.state === 'error' ? ` · ${data.code}` : ''}
            </p>
          )}
          {!online ? <p className="external-note">{t('external.offline')}</p> : null}
          {view?.error ? (
            <p className="err" role="alert">
              {whyNot(view.error, t)}
            </p>
          ) : null}
          {failure ? (
            <p className="err" role="alert">
              {whyNot(failure, t)}
            </p>
          ) : null}
          <footer className="external-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={dismiss}>
              {t(pending || !data ? 'external.cancel' : 'external.authClose')}
            </button>
            {pendingOwner ? (
              <button className="btn" type="button" disabled={busy || !online} onClick={consent}>
                {t('external.authConfirmOwner')}
              </button>
            ) : null}
          </footer>
        </section>
      </ExternalDialog>
      {paste ? (
        <ExternalTokenPrompt
          target={t('external.authPaste')}
          onClose={() => setPaste(false)}
          onSend={(token) => {
            setPaste(false)
            if (online)
              void run(() =>
                channel.command('external.identity.paste', {
                  deviceId,
                  operationId: externalOperationId(),
                  token,
                }),
              )
          }}
        />
      ) : null}
    </>
  )
}

function AuthorizationProfile({ profile }: { profile: ExternalIdentityAuthorization }) {
  const t = useT()
  const { account, repositories, scopes } = profile
  const { channel } = useServices()
  const [avatar, setAvatar] = useState<string | null>(null)
  const { userId } = account
  useEffect(() => {
    setAvatar(null)
    let active = true
    void channel.command('external.identity.avatar', { userId }).then(
      (result) => {
        if (active) setAvatar(result)
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [channel, userId])
  return (
    <div className="external-stack">
      <div className="external-row">
        {avatar ? (
          <img
            className="external-avatar"
            width={36}
            height={36}
            src={avatar}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="external-avatar external-avatar-placeholder" aria-hidden="true">
            {account.login.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="grow">
          <b>{account.name || `@${account.login}`}</b>
          <span className="dim">
            {' '}
            · @{account.login} · {account.userId}
          </span>
        </span>
      </div>
      {scopes.length ? (
        <p className="external-note">
          {t('external.authGrantedScopes')} {scopes.join(', ')}
        </p>
      ) : null}
      <div className="external-stack">
        <h3>{t('external.authRepos')}</h3>
        {repositories.length ? (
          <ul className="external-list external-auth-repos">
            {repositories.map((repo) => (
              <li key={repo.repoId}>
                <ExternalLink url={repo.url}>
                  {repo.owner}/{repo.name}
                </ExternalLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="external-note">{t('external.authNoRepos')}</p>
        )}
        {profile.repositoriesTruncated ? (
          <p className="external-note">{t('external.authMoreRepos')}</p>
        ) : null}
      </div>
    </div>
  )
}
