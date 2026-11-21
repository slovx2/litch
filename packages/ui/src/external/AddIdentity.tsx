// 添加 GitHub 身份的向导（对话框）。三种方式：设备码授权（默认，设备按需下载 GitHub CLI）、
// 导入设备上 gh 已登录的账号、粘贴令牌（高级）。设备码模式下必要权限锁定，可选权限可加；
// 等待时大号显示一次性码，可复制、可在系统浏览器打开 github.com/login/device。
// 授权到的是 owner 本人时要明确确认才保存；关掉对话框时仍在等待的授权一并取消。
import {
  EXTERNAL_IDENTITY_OPTIONAL_SCOPES,
  EXTERNAL_IDENTITY_REQUIRED_SCOPES,
  type ExternalIdentityLogin,
  type ExternalIdentityScope,
  isGithubCliSetupFailure,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { ExternalLink } from '../transcript/ExternalLink.tsx'
import { useIdentityLogin, useRun } from './data.ts'
import { clockText, operationId, secondsLeft } from './model.ts'
import { Avatar } from './parts.tsx'

type Way = 'device' | 'import' | 'paste'

function useSecondsLeft(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  return expiresAt === null ? 0 : secondsLeft(expiresAt, now)
}

function Waiting({ login }: { login: Extract<ExternalIdentityLogin, { state: 'waiting' }> }) {
  const t = useT()
  const left = useSecondsLeft(login.expiresAt)
  const copy = () => {
    void navigator.clipboard?.writeText(login.userCode).then(
      () => showToast({ id: 'ext-code', lifeMs: 2000, text: (t) => t('ext.wizard.copied') }),
      () => {},
    )
  }
  return (
    <div className="ext-code" data-ext-login="waiting">
      <div className="ext-code-box">
        <span className="ext-code-text mono" data-user-code>
          {login.userCode}
        </span>
        <button
          type="button"
          className="ibtn"
          data-act="code-copy"
          title={t('ext.wizard.copy')}
          aria-label={t('ext.wizard.copy')}
          onClick={copy}
        >
          <Icon name="copy" small />
        </button>
      </div>
      <div className="ext-code-line">
        <ExternalLink href={login.verificationUrl} openInSystem className="ext-text-link">
          {login.verificationUrl.replace(/^https:\/\//u, '')}
        </ExternalLink>
        <span className="dim">{t('ext.wizard.cliName')}</span>
      </div>
      <div className="ext-code-line dim">{t('ext.wizard.left', { time: clockText(left) })}</div>
    </div>
  )
}

export function AddIdentity({
  deviceId,
  onClose,
  reauthorize,
}: {
  deviceId: string
  onClose(): void
  reauthorize?: { login: string; scopes: readonly string[] }
}) {
  const t = useT()
  const { channel } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const [way, setWay] = useState<Way>('device')
  const [extra, setExtra] = useState<ExternalIdentityScope[]>(() =>
    EXTERNAL_IDENTITY_OPTIONAL_SCOPES.filter(
      (scope) => scope === 'notifications' || reauthorize?.scopes.includes(scope),
    ),
  )
  const [token, setToken] = useState('')
  const [loginId, setLoginId] = useState<string | null>(null)
  const [first, setFirst] = useState<ExternalIdentityLogin | null>(null)
  const act = useRun()
  const snapshot = useIdentityLogin(deviceId, loginId)
  const login = snapshot?.value ?? first
  const pending = login?.state === 'preparing' || login?.state === 'waiting'
  const awaiting = pending || (login?.state === 'succeeded' && login.needsConfirmation)
  const offerPaste =
    way === 'device' && login?.state === 'error' && isGithubCliSetupFailure(login.code)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const cancel = () => {
    if (!login || !awaiting) return Promise.resolve()
    return channel
      .command('external.identity.login.cancel', {
        deviceId,
        loginId: login.loginId,
        operationId: operationId(),
      })
      .then(
        () => {},
        () => {},
      )
  }
  const close = () => {
    void cancel()
    onClose()
  }

  const start = async () => {
    const op = operationId()
    const result = await act.run(() =>
      way === 'device'
        ? channel.command('external.identity.add', {
            deviceId,
            operationId: op,
            scopes: [...EXTERNAL_IDENTITY_REQUIRED_SCOPES, ...extra],
          })
        : way === 'import'
          ? channel.command('external.identity.import', { deviceId, operationId: op })
          : channel.command('external.identity.paste', { deviceId, operationId: op, token }),
    )
    setToken('')
    if (!result) return
    setFirst(result)
    setLoginId(result.loginId)
  }

  const confirm = async () => {
    if (login?.state !== 'succeeded') return
    const result = await act.run(() =>
      channel.command('external.identity.login.confirm', {
        deviceId,
        loginId: login.loginId,
        expectedRevision: login.revision,
        operationId: operationId(),
      }),
    )
    if (result) setFirst(result)
  }

  const restart = () => {
    setLoginId(null)
    setFirst(null)
  }

  let body = null
  if (!login) {
    body = (
      <>
        {reauthorize ? (
          <p className="dim">
            {t('ext.identity.notificationsAccount', { login: reauthorize.login })}
          </p>
        ) : null}
        <div className="seg">
          {(['device', 'import', 'paste'] as const).map((one) => (
            <button
              type="button"
              key={one}
              data-way={one}
              aria-pressed={way === one}
              onClick={() => setWay(one)}
            >
              {t(`ext.wizard.way.${one}`)}
            </button>
          ))}
        </div>
        {way === 'device' ? (
          <div className="ext-scopes" data-ext-scopes>
            {EXTERNAL_IDENTITY_REQUIRED_SCOPES.map((scope) => (
              <label key={scope} className="ext-check locked" title={t('ext.wizard.locked')}>
                <input type="checkbox" checked disabled />
                <span className="mono">{scope}</span>
              </label>
            ))}
            {EXTERNAL_IDENTITY_OPTIONAL_SCOPES.map((scope) => (
              <label key={scope} className="ext-check">
                <input
                  type="checkbox"
                  checked={extra.includes(scope)}
                  onChange={(event) =>
                    setExtra(
                      event.target.checked
                        ? [...extra, scope]
                        : extra.filter((one) => one !== scope),
                    )
                  }
                />
                <span className="mono">{scope}</span>
              </label>
            ))}
          </div>
        ) : way === 'paste' ? (
          <input
            className="req-input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder={t('ext.wizard.tokenHint')}
            aria-label={t('ext.wizard.way.paste')}
            onChange={(event) => setToken(event.target.value)}
          />
        ) : null}
      </>
    )
  } else if (login.state === 'preparing') {
    body = (
      <div className="devp-note" role="status" data-ext-login={login.phase}>
        {t(`ext.wizard.preparing.${login.phase}`)}
      </div>
    )
  } else if (login.state === 'waiting') {
    body = <Waiting login={login} />
  } else if (login.state === 'succeeded') {
    const { account, repositories, repositoriesTruncated, scopes } = login.result
    body = (
      <div className="ext-done" data-ext-login={login.needsConfirmation ? 'confirm' : 'done'}>
        <div className="ext-account">
          <Avatar userId={account.userId} login={account.login} />
          <b className="ell">{account.login}</b>
          <span className="dim mono">#{account.userId}</span>
        </div>
        <div className="dim">
          {t(repositoriesTruncated ? 'ext.wizard.reposMore' : 'ext.wizard.repos', {
            n: repositories.length,
          })}
          {scopes.length ? ` · ${scopes.join(' ')}` : ''}
        </div>
        {login.needsConfirmation ? (
          <div className="devp-note err" role="alert">
            {t('ext.wizard.ownerWarn')}
          </div>
        ) : null}
      </div>
    )
  } else {
    body = (
      <div className="devp-note err" role="alert" data-ext-login={login.state}>
        {offerPaste ? t('ext.wizard.setupFailed') : t(`ext.wizard.end.${login.state}`)}
        {login.state === 'error' ? ` (${login.code})` : ''}
      </div>
    )
  }

  const done = login?.state === 'succeeded' && !login.needsConfirmation
  return (
    <dialog
      ref={dialog}
      className="modal ext-dialog"
      aria-label={t('ext.identity.add')}
      onClose={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="modal-head">
          <span className="grow ell">{t('ext.identity.add')}</span>
          <button
            type="button"
            className="ibtn"
            title={t('ext.close')}
            aria-label={t('ext.close')}
            onClick={close}
          >
            <Close />
          </button>
        </div>
        <div className="modal-body">
          {body}
          {act.error ? (
            <div className="modal-note err" role="alert">
              {act.error}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          {!login ? (
            <button
              type="button"
              className="btn primary"
              data-act="identity-start"
              disabled={act.busy || (way === 'paste' && !token.trim())}
              onClick={() => void start()}
            >
              {t(`ext.wizard.start.${way}`)}
            </button>
          ) : login.state === 'succeeded' && login.needsConfirmation ? (
            <>
              <button type="button" className="btn ghost" onClick={close}>
                {t('ext.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                data-act="identity-confirm"
                disabled={act.busy}
                onClick={() => void confirm()}
              >
                {t('ext.wizard.useOwner')}
              </button>
            </>
          ) : done ? (
            <button
              type="button"
              className="btn primary"
              data-act="identity-done"
              onClick={onClose}
            >
              {t('ext.wizard.done')}
            </button>
          ) : pending ? (
            <button
              type="button"
              className="btn ghost"
              data-act="login-cancel"
              onClick={() => void cancel()}
            >
              {t('ext.cancel')}
            </button>
          ) : (
            <>
              <button type="button" className="btn" data-act="identity-retry" onClick={restart}>
                {t('ext.wizard.retry')}
              </button>
              {offerPaste ? (
                <button
                  type="button"
                  className="btn primary"
                  data-act="identity-use-token"
                  onClick={() => {
                    restart()
                    setWay('paste')
                  }}
                >
                  {t('ext.wizard.way.paste')}
                </button>
              ) : null}
            </>
          )}
        </div>
      </form>
    </dialog>
  )
}
