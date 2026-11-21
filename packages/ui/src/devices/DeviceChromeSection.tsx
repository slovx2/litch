import type { DeviceView } from '@litch/core'
import { useEffect, useId, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Fold } from '../app/Fold.tsx'
import { Ban, Check, Icon } from '../app/icons.tsx'
import { showToast } from '../app/toasts.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { ExternalLink } from '../transcript/ExternalLink.tsx'

type Status = NonNullable<DeviceView['remoteChrome']>

const CONDITIONS = {
  unprepared: ['chrome.unprepared', 'mute'],
  conflict: ['chrome.device.conflict', 'err'],
  waiting: ['chrome.disconnected', 'wait'],
  connected: ['chrome.connected', 'ok'],
  stopped: ['chrome.device.stopped', 'mute'],
  incompatible: ['chrome.device.incompatible', 'err'],
  error: ['chrome.device.error', 'err'],
} as const satisfies Record<Status['condition'], readonly [MessageKey, string]>

const NOTES: Partial<Record<Status['condition'], MessageKey>> = {
  connected: 'chrome.device.enabled',
  waiting: 'chrome.waitingHelp',
  stopped: 'chrome.stopped',
  incompatible: 'chrome.device.updateNote',
  error: 'chrome.device.errorNote',
}

function ChromeCommand({ command }: { command: string }) {
  const t = useT()
  const [copiedAt, setCopiedAt] = useState<number | null>(null)
  useEffect(() => {
    if (copiedAt === null) return
    const timer = window.setTimeout(() => setCopiedAt(null), 1500)
    return () => window.clearTimeout(timer)
  }, [copiedAt])
  const copied = copiedAt !== null
  const label = t(copied ? 'chrome.device.copied' : 'chrome.device.copy')
  return (
    <div className="cfail-cmd device-chrome-command">
      {/* 只滚动命令，复制按钮固定在右侧。键盘聚焦后也能查看全文。 */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 允许键盘滚动较长的命令。 */}
      <code className="mono" title={command} tabIndex={0}>
        {command}
      </code>
      <button
        type="button"
        className="mini"
        title={label}
        aria-label={label}
        data-copied={copied}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command)
            setCopiedAt(performance.now())
          } catch {
            setCopiedAt(null)
            showToast({
              id: 'device-chrome-copy',
              text: (t) => t('chrome.device.copyError'),
              tone: 'err',
              lifeMs: 4000,
            })
          }
        }}
      >
        {copied ? <Check /> : <Icon name="copy" small />}
      </button>
    </div>
  )
}

function SetupSteps({ status }: { status: Status }) {
  const t = useT()
  return (
    <ol className="device-chrome-steps">
      <li>
        <div className="mng-sec-body">
          <strong>{t('chrome.device.prepareStep')}</strong>
          <p className="mng-sec-note">{t('chrome.device.prepareNote')}</p>
          <ChromeCommand key={status.prepareCommand} command={status.prepareCommand} />
        </div>
      </li>
      <li>
        <div className="mng-sec-body">
          <strong>{t('chrome.device.installStep')}</strong>
          <p className="mng-sec-note">
            {t('chrome.device.installNote', { host: status.hostLabel })}
          </p>
          {status.storeUrl ? (
            <div>
              <ExternalLink className="linkish" href={status.storeUrl} openInSystem>
                {t('chrome.store')}
              </ExternalLink>
            </div>
          ) : null}
        </div>
      </li>
      <li>
        <div className="mng-sec-body">
          <strong>{t('chrome.device.accessStep')}</strong>
          <p className="mng-sec-note">
            {t(status.enabled ? 'chrome.device.accessOn' : 'chrome.device.enableNote')}
          </p>
          {status.enabled ? null : (
            <ChromeCommand key={status.enableCommand} command={status.enableCommand} />
          )}
        </div>
      </li>
    </ol>
  )
}

function ChromePanel({
  status,
  name,
  connected,
}: {
  status: Status
  name: string
  connected: boolean
}) {
  const t = useT()
  const bodyId = useId()
  const [panel, setPanel] = useState<'setup' | 'disable' | null>(connected ? null : 'setup')
  const [condition, tone] =
    status.condition === 'waiting' && !status.enabled
      ? (['chrome.device.disabled', 'mute'] as const)
      : CONDITIONS[status.condition]
  const note =
    status.condition === 'waiting' && !status.enabled ? undefined : NOTES[status.condition]
  const disableLabel = t('chrome.device.disableCommand')
  return (
    <section className="mng-sec" data-sec="device-chrome" data-condition={status.condition}>
      <div className="mng-sec-head">
        <h2>{t('chrome.device.title')}</h2>
        <span className="grow" />
        <div className="cfail-acts device-chrome-actions">
          <Fold
            open={panel === 'setup'}
            controls={bodyId}
            onToggle={() => setPanel(panel === 'setup' ? null : 'setup')}
          >
            {t('chrome.device.setup')}
          </Fold>
          {status.enabled ? (
            <button
              type="button"
              className="mini"
              data-act="device-chrome-disable"
              title={disableLabel}
              aria-label={disableLabel}
              aria-expanded={panel === 'disable'}
              aria-controls={panel === 'disable' ? bodyId : undefined}
              onClick={() => setPanel(panel === 'disable' ? null : 'disable')}
            >
              <Ban />
            </button>
          ) : null}
        </div>
      </div>
      <div className="device-chrome-summary" role="status">
        <div className="device-chrome-identity">
          <strong className="ell" title={status.hostLabel}>
            {name}
          </strong>
          <span aria-hidden="true">·</span>
          <span className={`pill ${tone}`}>{t(condition)}</span>
        </div>
        {note ? <p className="mng-sec-note">{t(note)}</p> : null}
      </div>
      {panel === 'setup' ? (
        <div id={bodyId} data-chrome-panel="setup">
          <SetupSteps status={status} />
        </div>
      ) : panel === 'disable' && status.enabled ? (
        <div id={bodyId} className="mng-sec-body" data-chrome-panel="disable">
          <p className="mng-sec-note">
            {t('chrome.device.disableNote', { host: status.hostLabel })}
          </p>
          <ChromeCommand key={status.disableCommand} command={status.disableCommand} />
        </div>
      ) : null}
    </section>
  )
}

export function DeviceChromeSection({ device }: { device: DeviceView }) {
  const t = useT()
  const status = device.remoteChrome
  if (!status) return null
  const connected = status.condition === 'connected' && status.enabled
  // 从未连接进入已连接时重新用收起的默认值，而不是沿用等待阶段已经展开的步骤。
  return (
    <ChromePanel
      key={`${device.id}:${connected}`}
      status={status}
      name={t.text(device.name)}
      connected={connected}
    />
  )
}
