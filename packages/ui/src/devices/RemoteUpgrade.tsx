// 远程设备服务的一键升级：设备详情“设备服务”一节里远程设备的那一段，和它的两种确认。
// 状态由核心记（DeviceView.remoteUpgrade），点了按钮、确认之后发 device.upgradeService；判断都在 service.ts 里。
// 没确认就什么都不做；“立即换上”会打断进行中的事，要再确认一次，写明会打断什么（决 467）。
import type { DeviceView, RemoteUpgradeView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { nameOf } from '../app/device.ts'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import {
  busyLine,
  installCommand,
  remoteButtonOf,
  remoteDoneLine,
  remoteNoticeOf,
  remoteOlderLine,
  remoteSteps,
} from './service.ts'
import { GuideSteps } from './status.tsx'

type Mode = 'start' | 'retry' | 'force'

/** 发一次 device.upgradeService。被拒（上一步没做完之类）时提示原因 */
function useUpgrade(deviceId: string): (mode: Mode) => void {
  const { channel } = useServices()
  return (mode) => {
    channel.command('device.upgradeService', { deviceId, mode }).catch((error: unknown) => {
      showToast({
        id: 'remote-upgrade',
        lifeMs: 6000,
        text: () => (error instanceof Error ? error.message : String(error)),
      })
    })
  }
}

/** 不闲的原因，一条一行 */
function BusyList({ device, view }: { device: DeviceView; view: RemoteUpgradeView }) {
  const t = useT()
  if (view.phase.step !== 'waiting') return null
  return (
    <ul className="svc-busy">
      {view.phase.busy.map((entry) => {
        const line = busyLine(entry, (id) => nameOf(device, id), t('list.comma'))
        return (
          <li key={`${entry.reason}:${entry.harnesses.join(',')}`} data-busy={entry.reason}>
            {t(line.key, line.args)}
          </li>
        )
      })}
    </ul>
  )
}

/** 第一次确认：在那台机器上做什么、用哪条命令、会不会打断 */
function UpgradeConfirm({
  device,
  view,
  onYes,
  onClose,
}: {
  device: DeviceView
  view: RemoteUpgradeView
  onYes(): void
  onClose(): void
}) {
  const t = useT()
  const name = t.text(device.name)
  const swap = view.action === 'swap'
  const to = view.target
  const from = view.running
  return (
    <Confirm
      title={t(swap ? 'service.remote.confirm.swapTitle' : 'service.remote.confirm.title', {
        name,
      })}
      yes={t(swap ? 'service.remote.confirm.swapYes' : 'service.remote.confirm.yes')}
      no={t('service.remote.confirm.no')}
      tone="primary"
      onYes={onYes}
      onClose={onClose}
    >
      <div className="svc-confirm" data-confirm={swap ? 'swap' : 'upgrade'}>
        <span>
          {swap
            ? t('service.remote.confirm.swapVersion', {
                installed: view.installed ?? to,
                from: from ?? '—',
              })
            : from === null
              ? t('service.remote.confirm.version.unknown', { to })
              : t('service.remote.confirm.version', { to, from })}
        </span>
        {!swap && view.method !== null ? (
          <>
            <span>
              {t(
                view.method === 'brew'
                  ? 'service.remote.confirm.brew'
                  : 'service.remote.confirm.script',
                {
                  to,
                },
              )}
            </span>
            <code className="svc-cmd mono" data-command>
              {installCommand(view.method, to)}
            </code>
          </>
        ) : null}
        <span>
          {t(view.managed ? 'service.remote.confirm.managed' : 'service.remote.confirm.idle')}
        </span>
      </div>
    </Confirm>
  )
}

/** “立即换上”的第二次确认：会打断的事逐条写出来 */
function ForceConfirm({
  device,
  view,
  onYes,
  onClose,
}: {
  device: DeviceView
  view: RemoteUpgradeView
  onYes(): void
  onClose(): void
}) {
  const t = useT()
  return (
    <Confirm
      title={t('service.remote.force.title')}
      yes={t('service.remote.force.yes')}
      no={t('service.remote.confirm.no')}
      onYes={onYes}
      onClose={onClose}
    >
      <div className="svc-confirm" data-confirm="force">
        <span>{t('service.remote.force.note', { name: t.text(device.name) })}</span>
        <BusyList device={device} view={view} />
        <span>{t('service.remote.force.clients')}</span>
      </div>
    </Confirm>
  )
}

/** “升级”或“换上新版”：点了先确认。没有按钮（做不了、认不出安装方式……）时什么都不画 */
export function UpgradeButton({ device, view }: { device: DeviceView; view: RemoteUpgradeView }) {
  const t = useT()
  const upgrade = useUpgrade(device.id)
  const [asking, setAsking] = useState(false)
  const button = remoteButtonOf(view)
  if (button === null) return null
  const failed = view.phase.step === 'failed'
  return (
    <>
      <button
        type="button"
        className="mini retry"
        data-act={`remote-${button}`}
        onClick={() => setAsking(true)}
      >
        {t(
          failed
            ? 'service.remote.again'
            : button === 'swap'
              ? 'service.remote.swap'
              : 'service.remote.upgrade',
        )}
      </button>
      {asking ? (
        <UpgradeConfirm
          device={device}
          view={view}
          onYes={() => {
            setAsking(false)
            upgrade('start')
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </>
  )
}

/** 设备服务一节里远程设备的那一段：比应用旧、进行到哪一步、没做成的原因和办法 */
export function RemoteUpgradeNote({
  device,
  view,
}: {
  device: DeviceView
  view: RemoteUpgradeView
}) {
  const t = useT()
  const upgrade = useUpgrade(device.id)
  const [forcing, setForcing] = useState(false)
  /** 远端的原话摆没摆出来：默认收着，点“详情”才摆 */
  const [said, setSaid] = useState(false)
  const notice = remoteNoticeOf(view)
  const { phase } = view
  const to = view.target
  const steps = remoteSteps(
    view,
    device.connection === 'online' ? (device.service?.pid ?? null) : null,
  )
  if (notice === null) return null
  if (notice === 'done') {
    const line = remoteDoneLine(view)
    return (
      <div className="cfail svc-note" data-remote-note="done">
        <div className="cfail-text">{t(line.key, line.args)}</div>
      </div>
    )
  }
  const older = remoteOlderLine(view)
  return (
    <div
      className="cfail svc-note"
      data-remote-note={notice}
      data-remote-method={view.method ?? 'unknown'}
    >
      {notice === 'older' || notice === 'failed' ? (
        <div className="cfail-text">{t(older.key, older.args)}</div>
      ) : null}
      {notice === 'older' && view.action === 'swap' && view.installed ? (
        <div className="cfail-text">
          {t('service.remote.swapOnly', { installed: view.installed })}
        </div>
      ) : null}
      {notice === 'older' && view.capable && steps.length > 0 ? (
        <div className="cfail-text">
          {t(
            view.action === 'swap' ? 'service.remote.managedSwap' : 'service.remote.unknownMethod',
          )}
        </div>
      ) : null}
      {notice === 'installing' ? (
        <div className="cfail-text">{t('service.remote.installing', { to })}</div>
      ) : null}
      {notice === 'stopping' || notice === 'forcing' || notice === 'reconnecting' ? (
        <div className="cfail-text">{t(`service.remote.${notice}`)}</div>
      ) : null}
      {notice === 'waiting' && phase.step === 'waiting' ? (
        <>
          <div className="cfail-text">{t('service.remote.waiting', { to })}</div>
          <BusyList device={device} view={view} />
          <div className="cfail-guide">
            <span>{t('service.remote.waiting.next')}</span>
          </div>
          <div className="cfail-acts">
            <button
              type="button"
              className="mini retry"
              data-act="remote-retry"
              disabled={phase.checking}
              onClick={() => upgrade('retry')}
            >
              {t(phase.checking ? 'service.remote.checking' : 'service.remote.retry')}
            </button>
            <button
              type="button"
              className="mini"
              data-act="remote-force"
              disabled={phase.checking}
              onClick={() => setForcing(true)}
            >
              {t('service.remote.force')}
            </button>
          </div>
        </>
      ) : null}
      {notice === 'restart' ? (
        <div className="cfail-text">{t('service.remote.restart', { to })}</div>
      ) : null}
      {notice === 'failed' && phase.step === 'failed' ? (
        <div className="cfail-text" data-failed={phase.at}>
          {t(`service.remote.failed.${phase.at}`, { to, installed: view.installed ?? '' })}
          {phase.text ? ` ${t.text(phase.text)}` : ''}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <GuideSteps steps={steps} args={{ to, pid: device.service?.pid ?? '' }} />
      ) : null}
      {notice === 'older' || notice === 'failed' ? (
        <div className="cfail-acts">
          <UpgradeButton device={device} view={view} />
          {phase.step === 'failed' && phase.detail ? (
            <button
              type="button"
              className="mini"
              aria-expanded={said}
              onClick={() => setSaid((value) => !value)}
            >
              {t('sidebar.detail')}
            </button>
          ) : null}
        </div>
      ) : null}
      {said && phase.step === 'failed' && phase.detail ? (
        <pre className="cfail-detail mono">{phase.detail}</pre>
      ) : null}
      {forcing ? (
        <ForceConfirm
          device={device}
          view={view}
          onYes={() => {
            setForcing(false)
            upgrade('force')
          }}
          onClose={() => setForcing(false)}
        />
      ) : null}
    </div>
  )
}
