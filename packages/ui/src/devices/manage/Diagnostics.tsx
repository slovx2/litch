// 诊断和日志：让设备服务把各个 harness 查一遍，逐项给结果；以及看一份日志的末尾。
// 都是即时的动作，和保存设置无关。
import type { DeviceView, DiagnosticCheckView, DiagnosticsView, LogTailView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { badgeOf, nameOf } from '../../app/device.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import type { MessageKey } from '../../i18n/index.ts'

const MARKS: Record<string, { cls: string; mark: string; title: MessageKey }> = {
  ok: { cls: 'check pass', mark: '✓', title: 'manage.diag.ok' },
  failed: { cls: 'check fail', mark: '×', title: 'manage.diag.failed' },
  skipped: { cls: 'check skip', mark: '–', title: 'manage.diag.skipped' },
}
/** 设备服务以后加了新的结果：按“不知道”显示 */
const UNKNOWN = { cls: 'check skip', mark: '?', title: 'manage.diag.unknown' } as const

function Check({ device, check }: { device: DeviceView; check: DiagnosticCheckView }) {
  const t = useT()
  const mark = MARKS[check.status] ?? UNKNOWN
  const scope = check.scope.kind === 'harness' ? check.scope.harness : ''
  return (
    <li className={mark.cls} data-check={`${scope}:${check.id}`} data-status={check.status}>
      <span className="mk" role="img" title={t(mark.title)} aria-label={t(mark.title)}>
        {mark.mark}
      </span>
      {scope ? <span className="chip">{badgeOf(device, scope)}</span> : null}
      <span className="diag-text">
        <span>
          {scope ? <span className="dim">{nameOf(device, scope)} · </span> : null}
          {t.said(check.title)}
        </span>
        {check.detail ? <span className="diag-detail">{t.said(check.detail)}</span> : null}
        {check.logPath ? <code className="mono dim">{check.logPath}</code> : null}
      </span>
    </li>
  )
}

export function Diagnostics({ device }: { device: DeviceView }) {
  const { channel } = useServices()
  const t = useT()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DiagnosticsView | null>(null)
  const [failure, setFailure] = useState<unknown>(null)

  const run = async () => {
    setRunning(true)
    setFailure(null)
    try {
      setResult(await channel.command('device.diagnostics.run', { deviceId: device.id }))
    } catch (error) {
      setFailure(error)
    } finally {
      setRunning(false)
    }
  }
  const failed = result?.checks.filter((check) => check.status === 'failed').length ?? 0

  return (
    <section className="mng-sec" data-sec="diagnostics" data-running={running}>
      <div className="mng-sec-head">
        <h2>{t('manage.diag.title')}</h2>
        <span className="grow" />
        <button
          type="button"
          className="btn"
          data-act="run-diagnostics"
          disabled={running}
          onClick={() => void run()}
        >
          {t(running ? 'manage.diag.running' : 'manage.diag.run')}
        </button>
      </div>
      <p className="mng-sec-note">{t('manage.diag.note')}</p>
      {failure ? (
        <div className="mng-note err" role="alert">
          {t('manage.failed', { reason: whyNot(failure, t) })}
        </div>
      ) : null}
      {result ? (
        <>
          <div className="form-note" data-diag-summary>
            {failed > 0
              ? t('manage.diag.summary.failed', { count: failed })
              : t('manage.diag.summary.ok')}
            {result.ranAt ? ` · ${new Date(result.ranAt).toLocaleTimeString(t.lang)}` : null}
          </div>
          <ul className="diag steps">
            {result.checks.map((check) => (
              <Check
                key={`${check.scope.kind === 'harness' ? check.scope.harness : ''}:${check.id}`}
                device={device}
                check={check}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

/** 文件有多大：给人看的写法 */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function Logs({ device }: { device: DeviceView }) {
  const { channel } = useServices()
  const t = useT()
  /** 选的是哪一份：device、service，或者“runtime:哪个 harness”“diagnostics:哪个 harness” */
  const [picked, setPicked] = useState('device')
  const [reading, setReading] = useState(false)
  const [log, setLog] = useState<{ picked: string; tail: LogTailView } | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const well = useRef<HTMLPreElement>(null)

  const read = async () => {
    const [source, harness] = picked.split(':') as [
      'device' | 'service' | 'runtime' | 'diagnostics',
      string | undefined,
    ]
    setReading(true)
    setFailure(null)
    try {
      const tail = await channel.command('device.logs.read', {
        deviceId: device.id,
        source,
        ...(harness ? { harness } : {}),
      })
      setLog({ picked, tail })
    } catch (error) {
      setFailure(error)
    } finally {
      setReading(false)
    }
  }
  // 日志看的是末尾：读到了就滚到最底下
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了一份内容就要重新滚到底
  useEffect(() => {
    if (well.current) well.current.scrollTop = well.current.scrollHeight
  }, [log])

  return (
    <section className="mng-sec" data-sec="logs">
      <div className="mng-sec-head">
        <h2>{t('manage.logs.title')}</h2>
        <span className="grow" />
        <select
          className="req-input mng-select"
          data-log-source
          aria-label={t('manage.logs.source')}
          value={picked}
          onChange={(event) => setPicked(event.target.value)}
        >
          <option value="device">{t('manage.logs.device')}</option>
          <option value="service">{t('manage.logs.service')}</option>
          {device.harnesses.map((harness) => (
            <option key={`r:${harness.id}`} value={`runtime:${harness.id}`}>
              {t('manage.logs.runtime', { name: harness.name })}
            </option>
          ))}
          {device.harnesses.map((harness) => (
            <option key={`d:${harness.id}`} value={`diagnostics:${harness.id}`}>
              {t('manage.logs.diagnostics', { name: harness.name })}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          data-act="read-log"
          disabled={reading}
          onClick={() => void read()}
        >
          {t(reading ? 'manage.loading' : 'manage.logs.read')}
        </button>
      </div>
      <p className="mng-sec-note">{t('manage.logs.note')}</p>
      {failure ? (
        <div className="mng-note err" role="alert">
          {t('manage.failed', { reason: whyNot(failure, t) })}
        </div>
      ) : null}
      {log ? (
        <div className="mng-log" data-log={log.picked} data-empty={log.tail.text === ''}>
          <div className="mng-log-head">
            <code className="mono dim ell">{log.tail.path}</code>
            {log.tail.truncated ? (
              <span className="form-note">
                {t('manage.logs.truncated', { size: sizeText(log.tail.size) })}
              </span>
            ) : null}
          </div>
          {log.tail.text ? (
            <pre ref={well} className="mono">
              {log.tail.text}
            </pre>
          ) : (
            <div className="form-note">{t('manage.logs.empty')}</div>
          )}
        </div>
      ) : null}
    </section>
  )
}
