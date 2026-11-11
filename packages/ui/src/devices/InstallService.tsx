import {
  hostLabel,
  type RemoteSetupPlan,
  type RemoteSetupStep,
  type RemoteTarget,
  runRemoteSetup,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { useServices } from '../app/services.tsx'

/** 三个未安装入口共用：检查只读，用户确认目标、版本和命令后才发送安装步骤。 */
export function InstallService({
  target,
  onConnected,
  onBusy,
}: {
  target: RemoteTarget
  onConnected?: (() => void | Promise<void>) | undefined
  onBusy?(busy: boolean): void
}) {
  const { channel } = useServices()
  const t = useT()
  const [plan, setPlan] = useState<RemoteSetupPlan | null>(null)
  const [asking, setAsking] = useState(false)
  const [step, setStep] = useState<RemoteSetupStep | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failedAt, setFailedAt] = useState<RemoteSetupStep | null>(null)
  const [done, setDone] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const lifetime = useRef<AbortController | null>(null)
  const wanted = JSON.stringify(target)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 表示用户明确重试，必须重新检查安装条件。
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    let id: string | null = null
    setPlan(null)
    setError(null)
    setDone(false)
    setStep(null)
    setFailedAt(null)
    setAsking(false)
    void channel
      .command(
        'remote.setup.prepare',
        { target: JSON.parse(wanted) },
        { signal: controller.signal },
      )
      .then((result) => {
        id = result.id
        if (!controller.signal.aborted) {
          setPlan(result)
          setError(result.detail ?? null)
        }
      })
      .catch((failed: unknown) => {
        if (!controller.signal.aborted)
          setError(failed instanceof Error ? failed.message : String(failed))
      })
    return () => {
      controller.abort()
      if (id) void channel.command('remote.setup.dismiss', { id }).catch(() => {})
    }
  }, [channel, wanted, attempt])
  const install = async () => {
    if (!plan || !lifetime.current || step) return
    const signal = lifetime.current.signal
    setAsking(false)
    setError(null)
    onBusy?.(true)
    let at: RemoteSetupStep = 'download'
    try {
      const result = await runRemoteSetup(
        channel,
        plan.id,
        (next) => {
          at = next
          setStep(next)
        },
        signal,
      )
      if (signal.aborted) return
      if (!result.ok)
        throw new Error(`${t.text(result.failure.text)}\n${result.failure.detail ?? ''}`)
      setDone(true)
      await onConnected?.()
    } catch (failed) {
      if (!signal.aborted) {
        setDone(false)
        setFailedAt(at)
        setError(failed instanceof Error ? failed.message : String(failed))
      }
    } finally {
      if (!signal.aborted) setStep(null)
      onBusy?.(false)
    }
  }
  return (
    <div
      className="cfail svc-note"
      data-install-service
      data-install-step={step ?? (done ? 'done' : 'idle')}
    >
      {step ? <div role="status">{t(`service.install.${step}`)}</div> : null}
      {done ? <div role="status">{t('service.install.done')}</div> : null}
      {!plan && !error ? <span>{t('service.install.checking')}</span> : null}
      {plan?.blocked ? <p>{t(`service.install.blocked.${plan.blocked}`)}</p> : null}
      {error ? (
        <div role="alert">
          {failedAt ? t('service.install.failed', { step: t(`service.install.${failedAt}`) }) : ''}
          <pre className="cfail-detail mono">{error}</pre>
        </div>
      ) : null}
      {plan && !step && !done ? (
        <>
          <div className="cfail-cmd">
            <code className="mono">{plan.command}</code>
            <button
              type="button"
              className="mini"
              onClick={() => {
                void navigator.clipboard?.writeText(plan.command)
              }}
            >
              {t('devices.guide.copy')}
            </button>
          </div>
          {plan.blocked ? null : error ? (
            <button type="button" className="mini" onClick={() => setAttempt((n) => n + 1)}>
              {t('sidebar.retry')}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              data-act="install-service"
              onClick={() => setAsking(true)}
            >
              {t('service.install.action')}
            </button>
          )}
        </>
      ) : null}
      {asking && plan ? (
        <Confirm
          title={t('service.install.title', { host: hostLabel(target) })}
          yes={t('service.install.action')}
          no={t('add.cancel')}
          tone="primary"
          onClose={() => setAsking(false)}
          onYes={() => {
            void install()
          }}
        >
          <span>{t('service.install.version', { version: plan.version })}</span>
          <code className="svc-cmd mono">{plan.command}</code>
        </Confirm>
      ) : null}
    </div>
  )
}
