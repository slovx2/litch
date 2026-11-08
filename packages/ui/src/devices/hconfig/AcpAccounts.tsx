import { useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { openOutside } from './parts.tsx'
import { useAcpAuth } from './useAcpAuth.ts'

export function AcpAccounts({ deviceId, harness }: { deviceId: string; harness: string }) {
  const t = useT()
  const { channel } = useServices()
  const { data, busy, error, methods, login, run } = useAcpAuth(channel, deviceId, harness)
  const [code, setCode] = useState('')
  return (
    <div className="hc-tab" data-hc-tab="accounts">
      <div className="hc-card" data-acp-auth>
        <h2>{t('hc.acp.title')}</h2>
        <p role="status">{t(busy ? `hc.acp.${busy}` : `hc.acp.${data?.status ?? 'unknown'}`)}</p>
        <p className="form-note">{t('hc.acp.instruction')}</p>
        {error ? (
          <p className="form-note bad" role="alert">
            {t('hc.acp.failed', { reason: whyNot(error, t) })}
          </p>
        ) : null}
        {login ? (
          <div className="hc-auth-form" data-acp-login-step>
            <p className="form-note">{t('hc.acp.linkInstruction')}</p>
            <div className="hc-auth-url">
              <code className="mono ell" title={login.url}>
                {login.url}
              </code>
              <button
                type="button"
                className="btn"
                data-acp-copy
                onClick={() => void navigator.clipboard?.writeText(login.url)}
              >
                {t('hc.acp.copy')}
              </button>
              <button
                type="button"
                className="btn primary"
                data-acp-open
                onClick={() => openOutside(login.url)}
              >
                {t('hc.acp.open')}
              </button>
            </div>
            <input
              className="req-input"
              value={code}
              placeholder={t('hc.acp.code')}
              onChange={(event) => setCode(event.target.value)}
            />
            <div className="hc-actions">
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || !code.trim()}
                onClick={() => {
                  void run('continue', code)
                  setCode('')
                }}
              >
                {t('hc.acp.submit')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy !== null && busy !== 'continue'}
                onClick={() => void run('cancel', login.attemptId)}
              >
                {t('hc.acp.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {data && methods.length === 0 ? <p className="form-note">{t('hc.acp.terminal')}</p> : null}
        <div className="hc-actions">
          {methods.map((method) => (
            <button
              type="button"
              className="btn"
              key={method.id}
              disabled={busy !== null || Boolean(login)}
              data-acp-login={method.id}
              onClick={() => void run('login', method.id)}
            >
              {t('hc.acp.personal')}
            </button>
          ))}
          {data?.logout ? (
            <button
              type="button"
              className="btn"
              disabled={busy !== null || Boolean(login) || data.status === 'signedOut'}
              data-acp-logout
              onClick={() => void run('logout')}
            >
              {t('hc.acp.signOut')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            data-acp-refresh
            onClick={() => void run('read')}
          >
            {t('hc.acp.refresh')}
          </button>
        </div>
      </div>
    </div>
  )
}
