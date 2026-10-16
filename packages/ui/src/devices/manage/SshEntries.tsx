// 给官方 Codex 桌面端的 SSH 入口：每个入口现在的状况（在听、关着、没起来和原因），以及可以复制走的 ssh 配置片段。
// 画的是设备服务报的状况（快照里固定有这一块），不靠设置项的键去猜哪个入口是哪个；
// 入口的开关和端口是普通的设置项，在下面按声明画。
// 这一节平时收着，标题行上只说有几个在监听；有入口没起来的时候标题行上多一个红的小标，原因点开看。
import type { DeviceView, SettingsSnapshotView, SshConfigView, SshEntryView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { badgeOf, nameOf } from '../../app/device.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import type { MessageKey } from '../../i18n/index.ts'
import { FoldSection } from './FoldSection.tsx'

const STATES: Record<string, { pill: string; label: MessageKey }> = {
  off: { pill: 'pill mute', label: 'manage.ssh.state.off' },
  listening: { pill: 'pill ok', label: 'manage.ssh.state.listening' },
  failed: { pill: 'pill err', label: 'manage.ssh.state.failed' },
  idle: { pill: 'pill wait', label: 'manage.ssh.state.idle' },
}
/** 设备服务以后加了新的状态：按“不知道”显示 */
const UNKNOWN = { pill: 'pill mute', label: 'manage.ssh.state.unknown' } as const

/** 把一段字放进剪贴板。按钮上的字变一下表示成了；没成出一条提示 */
function useCopy(): { copied: string | null; copy(text: string, mark: string): void } {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string, mark: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(mark)
        window.setTimeout(() => setCopied((now) => (now === mark ? null : now)), 1500)
      },
      () =>
        showToast({
          id: 'manage-copy',
          tone: 'err',
          text: (t) => t('manage.copy.failed'),
          lifeMs: 6000,
        }),
    )
  }
  return { copied, copy }
}

function Entry({ device, entry }: { device: DeviceView; entry: SshEntryView }) {
  const t = useT()
  const state = STATES[entry.state] ?? UNKNOWN
  return (
    <li className="ssh-entry" data-ssh-entry={entry.harness} data-state={entry.state}>
      <span className="ssh-entry-line">
        <span className="chip">{badgeOf(device, entry.harness)}</span>
        <span className="ell">{nameOf(device, entry.harness)}</span>
        <span className={state.pill}>{t(state.label)}</span>
        <span className="mono dim">{t('manage.ssh.port', { port: entry.port })}</span>
      </span>
      {entry.reason ? (
        <span className="ssh-why">
          {t.said(entry.reason.text)}
          {entry.reason.detail ? <code className="mono">{entry.reason.detail}</code> : null}
        </span>
      ) : null}
    </li>
  )
}

interface SshEntriesProps {
  device: DeviceView
  snapshot: SettingsSnapshotView
}

export function SshEntries({ device, snapshot }: SshEntriesProps) {
  const { channel } = useServices()
  const t = useT()
  const deviceId = device.id
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<SshConfigView | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const { copied, copy } = useCopy()
  const entries = snapshot.sshEntries
  // 入口的状况一变，片段可能也跟着变：开着的时候重新取
  const stamp = JSON.stringify(entries)

  // biome-ignore lint/correctness/useExhaustiveDependencies: stamp 变了就是入口的状况变了，要重新取
  useEffect(() => {
    if (!open) return
    let alive = true
    channel.command('device.sshConfig.read', { deviceId }).then(
      (view) => {
        if (!alive) return
        setConfig(view)
        setFailure(null)
      },
      (error: unknown) => {
        if (alive) setFailure(error)
      },
    )
    return () => {
      alive = false
    }
  }, [open, stamp, channel, deviceId])

  if (entries.length === 0) return null
  const listening = entries.filter((entry) => entry.state === 'listening').length
  const failed = entries.filter((entry) => entry.state === 'failed').length
  return (
    <FoldSection
      sec="ssh"
      title={t('manage.ssh.title')}
      forced={false}
      summary={
        <>
          {failed > 0 ? (
            <span className="pill err" data-ssh-failed={failed}>
              {t('manage.ssh.summary.failed', { count: failed })}
            </span>
          ) : null}
          <span className="mng-sum" data-ssh-listening={listening}>
            {listening > 0
              ? t('manage.ssh.summary.listening', { count: listening })
              : t('manage.ssh.summary.none')}
          </span>
        </>
      }
    >
      <p className="mng-sec-note">{t('manage.ssh.note')}</p>
      <ul className="ssh-entries">
        {entries.map((entry) => (
          <Entry key={entry.harness} device={device} entry={entry} />
        ))}
      </ul>
      <button
        type="button"
        className="btn ssh-config-btn"
        data-act="ssh-config"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t('manage.ssh.config')}
      </button>
      {open ? (
        <div className="ssh-config" data-ssh-config-panel>
          <span className="form-note">{t('manage.ssh.config.note')}</span>
          {failure ? (
            <span className="form-note err">
              {t('manage.failed', { reason: whyNot(failure, t) })}
            </span>
          ) : config === null ? (
            <span className="form-note">{t('manage.loading')}</span>
          ) : null}
          {config?.entries.map((entry) => (
            <div
              key={entry.harness}
              className="ssh-snippet"
              data-ssh-config={entry.harness}
              data-available={entry.config !== null}
            >
              <div className="ssh-snippet-head">
                <span className="chip">{badgeOf(device, entry.harness)}</span>
                <code className="mono">{entry.alias}</code>
                <span className="grow" />
                {entry.config ? (
                  <button
                    type="button"
                    className="mini"
                    data-act="copy-config"
                    onClick={() => copy(entry.config ?? '', entry.harness)}
                  >
                    {t(copied === entry.harness ? 'devices.guide.copied' : 'devices.guide.copy')}
                  </button>
                ) : null}
              </div>
              {entry.config ? (
                <pre className="mono">{entry.config}</pre>
              ) : (
                <span className="form-note">
                  {entry.unavailable ? t.said(entry.unavailable) : t('manage.ssh.config.none')}
                </span>
              )}
            </div>
          ))}
          {config && config.entries.filter((entry) => entry.config).length > 1 ? (
            <button
              type="button"
              className="btn"
              data-act="copy-all-config"
              onClick={() => copy(config.text, '*')}
            >
              {t(copied === '*' ? 'devices.guide.copied' : 'manage.ssh.config.copyAll')}
            </button>
          ) : null}
        </div>
      ) : null}
    </FoldSection>
  )
}
