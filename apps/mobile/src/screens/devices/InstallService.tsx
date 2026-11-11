import {
  type RemoteSetupPlan,
  type RemoteSetupStep,
  type RemoteTarget,
  runRemoteSetup,
} from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Confirm } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function InstallService({
  target,
  onConnected,
}: {
  target: RemoteTarget
  onConnected?: (() => void | Promise<void>) | undefined
}) {
  const channel = useChannel()
  const t = useT()
  const theme = useTheme()
  const [plan, setPlan] = useState<RemoteSetupPlan | null>(null)
  const [step, setStep] = useState<RemoteSetupStep | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failedAt, setFailedAt] = useState<RemoteSetupStep | null>(null)
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const life = useRef<AbortController | null>(null)
  const wanted = JSON.stringify(target)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 表示用户明确重试，必须重新检查安装条件。
  useEffect(() => {
    const controller = new AbortController()
    life.current = controller
    let id: string | null = null
    setPlan(null)
    setStep(null)
    setError(null)
    setDone(false)
    setAsking(false)
    setFailedAt(null)
    void channel
      .command(
        'remote.setup.prepare',
        { target: JSON.parse(wanted) },
        { signal: controller.signal },
      )
      .then((value) => {
        id = value.id
        if (!controller.signal.aborted) {
          setPlan(value)
          setError(value.detail ?? null)
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
    if (!plan || !life.current || step) return
    const signal = life.current.signal
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
    }
  }
  const ink = { color: theme.c.ink }
  return (
    <View testID="install-service">
      {!plan && !error ? <Text style={ink}>{t('service.install.checking')}</Text> : null}
      {step ? <Text style={ink}>{t(`service.install.${step}`)}</Text> : null}
      {done ? <Text style={ink}>{t('service.install.done')}</Text> : null}
      {plan?.blocked ? (
        <Text style={ink}>{t(`service.install.blocked.${plan.blocked}`)}</Text>
      ) : null}
      {error ? (
        <>
          <Text style={ink}>
            {failedAt
              ? t('service.install.failed', { step: t(`service.install.${failedAt}`) })
              : ''}
          </Text>
          <Text selectable style={ink}>
            {error}
          </Text>
        </>
      ) : null}
      {plan && !step && !done ? (
        <>
          <Text selectable style={[ink, { fontFamily: theme.font.mono }]}>
            {plan.command}
          </Text>
          <Button
            kind="plain"
            label={t('devices.key.copyCommand')}
            onPress={() => {
              void Clipboard.setStringAsync(plan.command)
            }}
          />
          {!plan.blocked ? (
            <Button
              label={t(error ? 'sidebar.retry' : 'service.install.action')}
              testID="install:ask"
              onPress={() => (error ? setAttempt((n) => n + 1) : setAsking(true))}
            />
          ) : null}
        </>
      ) : null}
      <Confirm
        visible={asking && !!plan}
        title={t('service.install.title', { host: plan?.host ?? '' })}
        detail={
          plan
            ? `${t('service.install.version', { version: plan.version })}\n\n${plan.command}`
            : ''
        }
        confirmLabel={t('service.install.action')}
        onClose={() => setAsking(false)}
        onConfirm={() => {
          void install()
        }}
      />
    </View>
  )
}
