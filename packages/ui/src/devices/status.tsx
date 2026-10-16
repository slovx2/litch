// 设备的连接状态怎么显示：一个状态小标，和“没连上”时的原因、该怎么办、对面的原话。
// 侧栏里的设备行和设备页共用这一份。
import type { ConnectFailureView, DeviceView, RemoteTarget } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import type { Args } from '../i18n/index.ts'
import { type GuideStep, guideOf } from './guide.ts'

type Shown = DeviceView['connection']

/**
 * 给人看的状态。连不上、正在隔一阵再试的设备说成“离线”：
 * 它可能关着机好几天，一直写“重连中”不像话；刚断开、第一次重试还没出结果时才说“重连中”。
 */
export const shownState = (device: DeviceView): Shown =>
  device.connection === 'reconnecting' && device.failure ? 'offline' : device.connection

const STATE_CLASS: Record<Shown, string> = {
  online: 'pill ok',
  connecting: 'pill wait',
  reconnecting: 'pill wait',
  offline: 'pill mute',
  error: 'pill err',
}

/** 设备页里用的完整状态小标 */
export function StatePill({ device }: { device: DeviceView }) {
  const t = useT()
  const state = shownState(device)
  return <span className={STATE_CLASS[state]}>{t(`devices.state.${state}`)}</span>
}

interface FailureProps {
  failure: ConnectFailureView
  target: RemoteTarget | null
  /** 给了就显示“重试” */
  onRetry?: (() => void) | undefined
}

/**
 * 该怎么办的那几步：每一步一句话，有命令的下面带一条可以复制去终端里运行的命令。
 * 设备详情里“只有 codex”时的安装指引也用它
 */
export function GuideSteps({ steps, args }: { steps: readonly GuideStep[]; args?: Args }) {
  const t = useT()
  /** 刚复制的是哪一条 */
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied((now) => (now === text ? null : now)), 1500)
    })
  }
  return steps.map((entry) => (
    <div key={entry.text} className="cfail-guide" data-guide={entry.text}>
      <span>{t(entry.text, args)}</span>
      {entry.command === null ? null : (
        <div className="cfail-cmd">
          <code className="mono">{entry.command}</code>
          <button type="button" className="mini" onClick={() => copy(entry.command ?? '')}>
            {t(copied === entry.command ? 'devices.guide.copied' : 'devices.guide.copy')}
          </button>
        </div>
      )}
    </div>
  ))
}

/** 没连上：原因、该怎么办、对面的原话 */
export function FailureNote({ failure, target, onRetry }: FailureProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="cfail" data-stage={failure.stage}>
      <div className="cfail-text">{t.text(failure.text)}</div>
      <GuideSteps steps={guideOf(failure, target)} />
      <div className="cfail-acts">
        {onRetry ? (
          <button type="button" className="mini retry" onClick={onRetry}>
            {t('sidebar.retry')}
          </button>
        ) : null}
        {failure.detail ? (
          <button
            type="button"
            className="mini"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {t('sidebar.detail')}
          </button>
        ) : null}
      </div>
      {open && failure.detail ? <pre className="cfail-detail mono">{failure.detail}</pre> : null}
    </div>
  )
}

/** 让一台设备立刻重新连 */
export function useReconnect(deviceId: string): () => void {
  const { channel } = useServices()
  return () => {
    channel.command('device.reconnect', { deviceId }).catch(() => {})
  }
}
