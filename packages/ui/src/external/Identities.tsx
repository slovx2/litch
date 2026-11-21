// 无人值守页 ① GitHub 身份：每个身份一行（头像、账号、凭据类型、状态点），行尾撤销；标题行的 + 打开添加向导。
// 一个身份可挂多枚凭据（高级粘贴的细粒度令牌按资源所有者分），多于一枚时逐枚列出。
import type { DeviceView, ExternalCredential, ExternalIdentity } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { AddIdentity } from './AddIdentity.tsx'
import { useRun } from './data.ts'
import { operationId } from './model.ts'
import { Avatar, Dot } from './parts.tsx'

const CREDENTIAL_TONE = { active: 'ok', invalid: 'err', revoked: 'off' } as const

function CredentialTag({ credential }: { credential: ExternalCredential }) {
  const t = useT()
  const kind = credential.credentialKind ?? 'fine_grained'
  return (
    <span
      className="pill mute"
      title={credential.scopes?.length ? credential.scopes.join(' ') : undefined}
    >
      {t(`ext.identity.kind.${kind}`)}
    </span>
  )
}

export function Identities({
  device,
  identities,
  error,
  writable,
  readOnly,
}: {
  device: DeviceView
  identities: ExternalIdentity[] | null
  error: string
  writable: boolean
  readOnly: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const [adding, setAdding] = useState(false)
  const [revoking, setRevoking] = useState<{
    identity: ExternalIdentity
    credential: ExternalCredential
  } | null>(null)
  const act = useRun()
  const online = device.connection === 'online'
  useEffect(() => {
    if (!writable || !online) {
      setAdding(false)
      setRevoking(null)
    }
  }, [writable, online])
  const revoke = async () => {
    if (!revoking || !writable || !online) return
    const { identity, credential } = revoking
    setRevoking(null)
    await act.run(() =>
      channel.command('external.identity.revoke', {
        deviceId: device.id,
        identityId: identity.identityId,
        credentialRef: credential.credentialRef,
        expectedGeneration: credential.generation,
        operationId: operationId(),
      }),
    )
  }
  return (
    <section className="ext-block" data-ext-identities>
      <div className="ext-block-head">
        <h3>{t('ext.identities')}</h3>
        <span className="grow" />
        {writable ? (
          <button
            type="button"
            className="ibtn"
            data-act="identity-add"
            title={t('ext.identity.add')}
            aria-label={t('ext.identity.add')}
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" small />
          </button>
        ) : null}
      </div>
      {readOnly ? (
        <div className="ext-empty" data-ext-admin-required>
          {t('external.adminRequired')}
        </div>
      ) : !online && identities === null ? null : identities === null ? (
        <div className="ext-empty">{error || t('ext.loading')}</div>
      ) : identities.length === 0 ? (
        <div className="ext-empty">{t('ext.identity.none')}</div>
      ) : (
        <ul className="ext-list">
          {identities.flatMap((identity) =>
            (identity.credentials.length ? identity.credentials : [null]).map(
              (credential, index) => (
                <li
                  className="ext-row"
                  key={`${identity.identityId}:${credential?.credentialRef ?? ''}`}
                  data-identity={identity.identityId}
                >
                  {index === 0 ? (
                    <Avatar userId={identity.botUserId} login={identity.login} />
                  ) : (
                    <span className="ext-avatar ghost" />
                  )}
                  <b className="ext-row-name ell">{index === 0 ? identity.login : ''}</b>
                  {credential ? <CredentialTag credential={credential} /> : null}
                  {credential && identity.credentials.length > 1 ? (
                    <span className="ext-row-meta mono">#{credential.resourceOwnerId}</span>
                  ) : null}
                  <span className="grow" />
                  {credential ? (
                    <>
                      <Dot
                        tone={CREDENTIAL_TONE[credential.state]}
                        label={t(`ext.identity.state.${credential.state}`)}
                      />
                      {credential.state === 'revoked' ? null : (
                        <button
                          type="button"
                          className="ibtn"
                          data-act="identity-revoke"
                          title={t('ext.identity.revoke')}
                          aria-label={t('ext.identity.revoke')}
                          disabled={!online || !writable || act.busy}
                          onClick={() => setRevoking({ identity, credential })}
                        >
                          <Icon name="trash" small />
                        </button>
                      )}
                    </>
                  ) : null}
                </li>
              ),
            ),
          )}
        </ul>
      )}
      {act.error ? (
        <div className="devp-note err" role="alert">
          {act.error}
        </div>
      ) : null}
      {writable && online && revoking ? (
        <Confirm
          title={t('ext.identity.revokeTitle', { login: revoking.identity.login })}
          note={t('ext.identity.revokeNote')}
          yes={t('ext.identity.revoke')}
          no={t('ext.cancel')}
          onYes={() => void revoke()}
          onClose={() => setRevoking(null)}
        />
      ) : null}
      {writable && online && adding ? (
        <AddIdentity deviceId={device.id} onClose={() => setAdding(false)} />
      ) : null}
    </section>
  )
}
