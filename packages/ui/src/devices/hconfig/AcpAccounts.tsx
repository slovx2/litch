import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { useAcpAuth } from './useAcpAuth.ts'

export function AcpAccounts({ deviceId, harness }: { deviceId: string; harness: string }) {
  const t = useT()
  const { channel } = useServices()
  const { data, busy, error, methods, run } = useAcpAuth(channel, deviceId, harness)
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
        {data && methods.length === 0 ? <p className="form-note">{t('hc.acp.terminal')}</p> : null}
        <div className="hc-actions">
          {methods.map((method) => (
            <button
              type="button"
              className="btn"
              key={method.id}
              disabled={busy !== null}
              data-acp-login={method.id}
              onClick={() => void run('login', method.id)}
            >
              {t(method.id === 'oauth-business' ? 'hc.acp.business' : 'hc.acp.personal')}
            </button>
          ))}
          {data?.logout ? (
            <button
              type="button"
              className="btn"
              disabled={busy !== null || data.status === 'signedOut'}
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
