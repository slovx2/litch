import type { DeviceView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import type { MessageKey } from '../i18n/index.ts'

const CONDITIONS = {
  unprepared: 'chrome.unprepared',
  conflict: 'chrome.device.conflict',
  waiting: 'chrome.disconnected',
  connected: 'chrome.connected',
  stopped: 'chrome.stopped',
  incompatible: 'chrome.device.incompatible',
  error: 'chrome.device.error',
} satisfies Record<NonNullable<DeviceView['remoteChrome']>['condition'], MessageKey>

export function DeviceChromeSection({
  status,
}: {
  status: NonNullable<DeviceView['remoteChrome']>
}) {
  const t = useT()
  const [copy, setCopy] = useState<'ready' | 'copied' | 'error'>('ready')
  const command = status.prepareCommand
  return (
    <section className="mng-sec" data-sec="device-chrome">
      <div className="mng-sec-head">
        <h2>{t('chrome.device.title')}</h2>
      </div>
      <p>
        {t('chrome.device.status', {
          host: status.hostLabel,
          status: t(CONDITIONS[status.condition]),
        })}
      </p>
      <p>{t(status.enabled ? 'chrome.device.enabled' : 'chrome.device.disabled')}</p>
      <p>{t('chrome.device.prepareNote')}</p>
      <div className="well">
        <pre>{command}</pre>
      </div>
      <button
        type="button"
        className="btn ghost"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(
            () => setCopy('copied'),
            () => setCopy('error'),
          )
        }}
      >
        {t(copy === 'copied' ? 'chrome.device.copied' : 'chrome.device.copy')}
      </button>
      {copy === 'error' ? <p role="alert">{t('chrome.device.copyError')}</p> : null}
      <p>{t('chrome.device.installNote')}</p>
      {status.storeUrl ? (
        <div className="well">
          <pre>{status.storeUrl}</pre>
        </div>
      ) : null}
      <div className="well">
        <pre>{status.enabled ? status.disableCommand : status.enableCommand}</pre>
      </div>
    </section>
  )
}
