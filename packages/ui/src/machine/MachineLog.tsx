// 设备详情里“最近的操作”：这台设备上的会话在这台电脑上做过什么（08 号设计 3.4）。只存在这台电脑上。
// 默认收着，点开才去取（命令 machine.log，不走订阅），新的在前；结果按颜色分开，碰到禁止位置的标出来；能清空。
import type { DeviceView, MachineLogEntry, SessionSummary } from '@litch/core'
import { keys } from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { useNow } from '../app/clock.ts'
import { nameOf } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Fold } from '../app/Fold.tsx'
import { ago } from '../app/format.ts'
import { useKey, useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { resultTone } from './logic.ts'

const RESULT_TEXT: Record<MachineLogEntry['result'], MessageKey> = {
  ok: 'machine.result.ok',
  failed: 'machine.result.failed',
  declined: 'machine.result.declined',
  blocked: 'machine.result.blocked',
  expired: 'machine.result.expired',
  disabled: 'machine.result.disabled',
}

/** 取的状态：还没取、正在取、取到了、没取到 */
type Loaded =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; entries: MachineLogEntry[] }
  | { state: 'failed'; reason: string }

export function MachineLog({ deviceId }: { deviceId: string }) {
  const { channel } = useServices()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' })
  const [asking, setAsking] = useState(false)
  const listId = `mach-log-${deviceId}`

  const load = useCallback(() => {
    setLoaded({ state: 'loading' })
    channel
      .command('machine.log', { deviceId })
      .then(({ entries }) => setLoaded({ state: 'ready', entries }))
      .catch((error: unknown) => setLoaded({ state: 'failed', reason: reasonOf(error, t) }))
  }, [channel, deviceId, t])

  // 每次点开都重新取一遍：记录不推增量，开着的时候“刷新”再取
  useEffect(() => {
    if (open) load()
  }, [open, load])

  const clear = () => {
    setAsking(false)
    channel
      .command('machine.log.clear', { deviceId })
      .then(() => setLoaded({ state: 'ready', entries: [] }))
      .catch((error: unknown) => setLoaded({ state: 'failed', reason: reasonOf(error, t) }))
  }

  const entries = loaded.state === 'ready' ? loaded.entries : []
  return (
    <div className="mach-sub mach-log" data-sub="log">
      <div className="mach-log-head">
        <Fold open={open} onToggle={() => setOpen(!open)} controls={listId} className="mach-fold">
          {t('machine.log')}
        </Fold>
        <span className="grow" />
        {open ? (
          <>
            <button type="button" className="mini" data-act="log-refresh" onClick={load}>
              {t('machine.log.refresh')}
            </button>
            <button
              type="button"
              className="mini"
              data-act="log-clear"
              disabled={entries.length === 0}
              onClick={() => setAsking(true)}
            >
              {t('machine.log.clear')}
            </button>
          </>
        ) : null}
      </div>
      {open ? (
        <div id={listId} className="mach-log-body">
          {loaded.state === 'failed' ? (
            <div className="mach-empty err" role="alert">
              {t('machine.log.failed', { reason: loaded.reason })}
            </div>
          ) : loaded.state !== 'ready' ? (
            <div className="mach-empty">{t('machine.log.loading')}</div>
          ) : entries.length === 0 ? (
            <div className="mach-empty">{t('machine.log.empty')}</div>
          ) : (
            <ol className="mach-entries">
              {entries.map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 记录没有标识，同一毫秒可能有两条；整份取回来才换
                <LogRow key={`${entry.at}-${index}`} entry={entry} />
              ))}
            </ol>
          )}
        </div>
      ) : null}
      {asking ? (
        <Confirm
          title={t('machine.log.clear.title')}
          note={t('machine.log.clear.note')}
          yes={t('machine.log.clear')}
          no={t('permission.confirm.no')}
          onYes={clear}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}

function LogRow({ entry }: { entry: MachineLogEntry }) {
  const t = useT()
  const now = useNow()
  const device = useKey<DeviceView>(keys.device(entry.deviceId))
  const summary = useKey<SessionSummary>(keys.summary(entry.deviceId, entry.sessionId ?? ''))
  const tone = resultTone(entry.result)
  const session = entry.sessionId
    ? summary
      ? t.text(summary.title)
      : t('machine.session.gone')
    : t('machine.session.unknown')
  return (
    <li className="mach-entry" data-result={entry.result} data-flagged={entry.flagged || undefined}>
      <span className="mach-when" title={new Date(entry.at).toLocaleString()}>
        {ago(entry.at, now, t)}
      </span>
      <span className={`pill ${tone}`}>{t(RESULT_TEXT[entry.result])}</span>
      <span className="mach-what">
        <span className="mach-tool mono">{entry.tool}</span>
        <span className="mono ell" title={entry.summary}>
          {entry.summary}
        </span>
      </span>
      <span className="mach-who ell">
        {entry.harness ? `${nameOf(device, entry.harness)} · ` : ''}
        {session}
      </span>
      {entry.flagged ? <span className="mach-flag-mark">{t('machine.flagged')}</span> : null}
    </li>
  )
}
