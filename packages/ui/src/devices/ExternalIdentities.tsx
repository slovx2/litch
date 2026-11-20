import type { ExternalCredential, ExternalIdentity } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { ExternalDialog, ExternalTokenPrompt } from './ExternalControls.tsx'
import { ExternalIdentityLoginDialog } from './ExternalIdentityLogin.tsx'
import { externalOperationId, externalTime } from './external-view.ts'

type Selection = { identity: ExternalIdentity; credential: ExternalCredential }

export function ExternalIdentities({
  deviceId,
  online,
  revision,
}: {
  deviceId: string
  online: boolean
  revision: number | undefined
}) {
  const t = useT()
  const { channel } = useServices()
  const [identities, setIdentities] = useState<ExternalIdentity[] | null>(null)
  const [prompt, setPrompt] = useState<Selection | null>(null)
  const [authorizing, setAuthorizing] = useState(false)
  const [revoke, setRevoke] = useState<Selection | null>(null)
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!online || revision === undefined) return
    let active = true
    void channel.command('external.identity.list', { deviceId }).then(
      (result) => {
        if (active) setIdentities(result.identities)
      },
      (cause: unknown) => {
        if (active) setError(cause)
      },
    )
    return () => {
      active = false
    }
  }, [channel, deviceId, online, revision])

  const change = async (work: () => Promise<{ identity: ExternalIdentity }>) => {
    setBusy(true)
    setError(undefined)
    try {
      const { identity } = await work()
      setIdentities((all) => [
        ...(all ?? []).filter((row) => row.identityId !== identity.identityId),
        identity,
      ])
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }
  const scope = (one: Selection) => ({
    deviceId,
    identityId: one.identity.identityId,
    credentialRef: one.credential.credentialRef,
    expectedGeneration: one.credential.generation,
    operationId: externalOperationId(),
  })
  return (
    <section className="external-panel external-stack" data-external-identities>
      <div className="external-row">
        <h3 className="grow">① {t('external.identities')}</h3>
        <button
          type="button"
          className="mini external-button"
          disabled={!online || busy || revision === undefined}
          title={!online ? t('external.offline') : undefined}
          onClick={() => setAuthorizing(true)}
        >
          <Icon name="plus" small />
          {t('external.addIdentity')}
        </button>
      </div>
      {identities?.length === 0 ? (
        <p className="external-note">{t('external.noIdentities')}</p>
      ) : null}
      {identities?.map((identity) => (
        <div className="external-stack" key={identity.identityId}>
          <div className="external-row">
            <b>@{identity.login}</b>
            <span className="dim">· {identity.botUserId}</span>
          </div>
          <ul className="external-list">
            {identity.credentials.map((credential) => (
              <li key={credential.credentialRef} className="external-row">
                <span className="grow">
                  {credential.credentialKind === 'oauth'
                    ? `GitHub CLI${credential.scopes?.length ? ` · ${credential.scopes.join(', ')}` : ''}`
                    : t('external.credentialOwner', { id: credential.resourceOwnerId })}
                  {credential.expiresAt
                    ? ` · ${t('external.credentialExpiry', { time: externalTime(credential.expiresAt, t.lang) })}`
                    : ''}
                </span>
                <span className={`pill ${credential.state === 'active' ? 'ok' : 'mute'}`}>
                  {t(`external.credential.${credential.state}`)}
                </span>
                {credential.state !== 'revoked' ? (
                  <>
                    <button
                      className="mini"
                      type="button"
                      disabled={!online || busy}
                      onClick={() =>
                        credential.credentialKind === 'oauth'
                          ? setAuthorizing(true)
                          : setPrompt({ identity, credential })
                      }
                    >
                      {t(
                        credential.credentialKind === 'oauth'
                          ? 'external.authAgain'
                          : 'external.rotateToken',
                      )}
                    </button>
                    <button
                      className="mini"
                      type="button"
                      disabled={!online || busy}
                      onClick={() => setRevoke({ identity, credential })}
                    >
                      {t('external.revokeToken')}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {error ? (
        <p className="err" role="alert">
          {whyNot(error, t)}
        </p>
      ) : null}
      {authorizing ? (
        <ExternalIdentityLoginDialog
          deviceId={deviceId}
          online={online}
          close={() => setAuthorizing(false)}
        />
      ) : null}
      {prompt ? (
        <ExternalTokenPrompt
          target={t('external.rotateToken')}
          onClose={() => setPrompt(null)}
          onSend={(token) => {
            const current = prompt
            setPrompt(null)
            if (online)
              void change(() =>
                channel.command('external.identity.rotate', { ...scope(current), token }),
              )
          }}
        />
      ) : null}
      {revoke ? (
        <ExternalDialog label={t('external.revokeToken')} close={() => setRevoke(null)}>
          <div className="external-stack">
            <p>
              {t('external.revokeTokenNote', {
                account: revoke.identity.login,
                id: revoke.credential.resourceOwnerId,
              })}
            </p>
            <div className="external-actions">
              <button type="button" className="btn ghost" onClick={() => setRevoke(null)}>
                {t('external.cancel')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!online || busy}
                onClick={() => {
                  const args = scope(revoke)
                  setRevoke(null)
                  void change(() => channel.command('external.identity.revoke', args))
                }}
              >
                {t('external.revokeToken')}
              </button>
            </div>
          </div>
        </ExternalDialog>
      ) : null}
    </section>
  )
}
