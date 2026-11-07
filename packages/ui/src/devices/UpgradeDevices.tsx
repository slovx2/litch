// 应用重启后按当前版本汇总；每台设备独立执行，慢连接和失败不挡其他设备。
import { type DeviceView, keys, type ServiceBusyView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { requestDevice } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { nameOf } from '../app/device.ts'
import { Check, Close } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { updateBridge } from '../settings/update-bridge.ts'
import { busyLine } from './service.ts'
import { type UpgradeChoice, upgradeCandidate, upgradeChoices } from './upgrade-plan.ts'

function UpgradeRow({
  device,
  choice,
  choose,
  initialBusy,
}: {
  device: DeviceView
  initialBusy: ServiceBusyView[] | null
  choice: UpgradeChoice
  choose(value: UpgradeChoice): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [busy, setBusy] = useState<ServiceBusyView[] | null>(initialBusy)
  useEffect(() => {
    let closed = false
    const check = () =>
      void channel.command('device.serviceActivity', { deviceId: device.id }).then(
        (result) => {
          if (closed) return
          setBusy(result.busy)
          if (device.kind === 'local' && result.busy?.length === 0)
            void channel
              .command('device.restartService', { deviceId: device.id, mode: 'auto' })
              .catch(() => {})
        },
        () => {
          if (!closed) setBusy(null)
        },
      )
    check()
    const timer = window.setInterval(check, 30_000)
    return () => {
      closed = true
      window.clearInterval(timer)
    }
  }, [channel, device.id, device.kind])
  const reasons = busy ?? device.upgrade?.busy ?? []
  return (
    <div className="upgrade-device-row" data-upgrade-device={device.id}>
      <label>
        <strong>{t.text(device.name)}</strong>
        <span className="mono">
          {device.service?.version ?? t('service.version.unknown')} →{' '}
          {device.upgrade?.bundled.version ?? device.remoteUpgrade?.target}
        </span>
        <span className="upgrade-state">
          {busy === null
            ? t('service.batch.unknown')
            : busy.length === 0
              ? t('service.batch.idleState')
              : ''}
          {reasons
            .map((reason) => {
              const line = busyLine(reason, (id) => nameOf(device, id, t), t('list.comma'))
              return t(line.key, line.args)
            })
            .join(t('list.comma'))}
        </span>
        <select
          value={choice}
          onChange={(event) => choose(event.target.value as UpgradeChoice)}
          aria-label={t.text(device.name)}
        >
          {upgradeChoices(device).map((value) => (
            <option key={value} value={value}>
              {t(`service.batch.${value}`)}
            </option>
          ))}
        </select>
      </label>

      {choice === 'force' ? <span className="set-note">{t('service.batch.forceNote')}</span> : null}
    </div>
  )
}

export function UpgradeDevices() {
  const { channel, replica } = useServices()
  const t = useT()
  const ids = useKey<string[]>(keys.devices) ?? []
  const devices = useKeys<DeviceView>(ids.map(keys.device))
  const [version, setVersion] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, UpgradeChoice>>({})
  const [ready, setReady] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [promptIds, setPromptIds] = useState<string[] | null>(null)
  const handled = useRef(false)
  const mounted = useRef(true)
  const [activity, setActivity] = useState<Record<string, ServiceBusyView[] | null>>({})
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const failures = useRef(new Map<string, string>())
  useEffect(() => {
    let closed = false
    void updateBridge()
      ?.get()
      .then((view) => {
        if (!closed && view?.version) setVersion(view.version)
      })
      .catch(() => {})
    return () => {
      closed = true
    }
  }, [])
  useEffect(() => {
    for (const device of devices) {
      const phase = device?.remoteUpgrade?.phase
      if (!device) continue
      if (phase?.step !== 'failed') {
        failures.current.delete(device.id)
        continue
      }
      const signature = JSON.stringify(phase)
      if (failures.current.get(device.id) === signature) continue
      failures.current.set(device.id, signature)
      showToast({
        id: `upgrade-${device.id}`,
        tone: 'err',
        lifeMs: 0,
        text: (say) =>
          `${say.text(device.name)}: ${say(`service.remote.failed.${phase.at}`, { to: device.remoteUpgrade?.target ?? '', installed: device.remoteUpgrade?.installed ?? '' })} ${phase.text ? say.text(phase.text) : ''} ${phase.detail ?? ''} ${say('service.batch.failure')}`,
        action: {
          label: (say) => say('service.batch.details'),
          run: () => requestDevice(device.id, 'service'),
        },
      })
    }
  }, [devices])
  useEffect(() => {
    // 等初始化与各设备握手；慢连接最多等十五秒，不把断开的旧快照放进提示。
    const first = window.setTimeout(() => setReady(true), 1500)
    const deadline = window.setTimeout(() => setTimedOut(true), 15_000)
    return () => {
      window.clearTimeout(first)
      window.clearTimeout(deadline)
    }
  }, [])
  useEffect(() => {
    if (!version || !ready || handled.current) return
    if (localStorage.getItem('litch.device-upgrade.prompt-version') === version) return
    if (
      !timedOut &&
      (devices.length === 0 ||
        devices.some((device) => !device || !['online', 'error'].includes(device.connection)))
    )
      return
    handled.current = true
    const candidates = devices.filter(
      (device): device is DeviceView => !!device && upgradeCandidate(device, version),
    )
    const found: Record<string, ServiceBusyView[] | null> = {}
    let timer: number | undefined
    // 各设备并行只读探测，超时保留未知；不能让一台无响应的设备拖住整个提示。
    void Promise.race([
      Promise.allSettled(
        candidates.map(async (device) => {
          const { busy } = await channel.command('device.serviceActivity', { deviceId: device.id })
          found[device.id] = busy
        }),
      ),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, 5000)
      }),
    ]).then(() => {
      window.clearTimeout(timer)
      if (!mounted.current) return
      localStorage.setItem('litch.device-upgrade.prompt-version', version)
      setActivity({ ...found })
      const shown: string[] = []
      for (const device of candidates) {
        const current = replica.store.get<DeviceView>(keys.device(device.id))
        if (!current || !upgradeCandidate(current, version)) continue
        if (device.kind === 'local' && found[device.id]?.length === 0) {
          void channel
            .command('device.restartService', { deviceId: device.id, mode: 'auto' })
            .catch(() => {})
        } else shown.push(device.id)
      }
      setPromptIds(shown)
    })
  }, [channel, replica, devices, ready, timedOut, version])
  const rows = devices.filter(
    (device): device is DeviceView =>
      !!device &&
      promptIds?.includes(device.id) === true &&
      version !== null &&
      upgradeCandidate(device, version),
  )
  useEffect(() => {
    // 对话框里最后一台断开或已升级，就结束这次提示，不在它重连时重新弹出。
    if (promptIds?.length && rows.length === 0) setPromptIds([])
  }, [promptIds, rows.length])
  const close = () => setPromptIds([])
  if (rows.length === 0) return null
  return (
    <Confirm
      className="upgrade-prompt"
      title={t('service.batch.title')}
      note={t('service.batch.note')}
      yes={
        <>
          <Check />
          {t('service.batch.apply')}
        </>
      }
      no={
        <>
          <Close />
          {t('service.batch.none')}
        </>
      }
      tone="primary"
      onClose={close}
      onYes={() => {
        close()
        for (const device of rows) {
          const choice = choices[device.id] ?? 'none'
          if (choice === 'none') continue
          const command =
            device.kind === 'local'
              ? channel.command('device.restartService', {
                  deviceId: device.id,
                  mode: choice === 'force' ? 'force' : 'auto',
                })
              : channel.command('device.upgradeService', { deviceId: device.id, mode: 'start' })
          void command.catch((error: unknown) =>
            showToast({
              id: `upgrade-${device.id}`,
              tone: 'err',
              lifeMs: 0,
              text: (say) =>
                `${say.text(device.name)}: ${String(error)} ${say('service.batch.failure')}`,
              action: {
                label: (say) => say('service.batch.details'),
                run: () => requestDevice(device.id, 'service'),
              },
            }),
          )
        }
      }}
    >
      <div className="upgrade-devices">
        {rows.map((device) => (
          <UpgradeRow
            key={device.id}
            device={device}
            initialBusy={activity[device.id] ?? null}
            choice={choices[device.id] ?? 'none'}
            choose={(value) => setChoices((old) => ({ ...old, [device.id]: value }))}
          />
        ))}
      </div>
    </Confirm>
  )
}
