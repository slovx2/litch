// 设备列表的一行：只放一眼要看的——是谁、连没连上、上面有什么、忙不忙、最近什么时候动过。
// 别的（怎么连的、线色、改名、改连接、移除、没连上的原因和该怎么办）都在点进去的详情里。
// 往这一行上加东西之前先想它是不是该进详情：这一行上没有按钮，也没有说明文字，整行就是进详情的入口。
import { type DeviceActivity, type DeviceView, keys } from '@litch/core'
import { useEffect, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { chipTitle, downHarness, wireStyle } from '../app/device.ts'
import { ago } from '../app/format.ts'
import { Forward, Notice } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { staleRemote, staleService } from './service.ts'
import { StatePill } from './status.tsx'

/** 一行上最多摆几个 harness 的徽标，再多的收成“+N” */
const SHOWN = 4

interface DeviceRowProps {
  deviceId: string
  /** 刚从这台设备的详情里退回来：焦点落回这一行，键盘接着往下走 */
  focus: boolean
  onOpen(): void
}

/** 这台设备上有哪些 harness：个数，加一排徽标。用不了的徽标画成虚线、字淡一档 */
function Harnesses({ device }: { device: DeviceView }) {
  const t = useT()
  const { harnesses } = device
  // 对面什么都没装：这一栏照实说，不摆上次留下的徽标
  if (device.kind === 'ssh' && device.failure?.stage === 'notInstalled') {
    return (
      <span className="devp-cell devp-has dim" data-peer="none">
        {t('devices.peer.none')}
      </span>
    )
  }
  // 还没连上过：有什么要连上之后才知道
  if (harnesses.length === 0) {
    return (
      <span className="devp-cell devp-has dim" title={t('devices.harness.unknown')}>
        —
      </span>
    )
  }
  const folded = harnesses.slice(SHOWN)
  // 远程设备上没有设备服务、连的是单个 harness（原生 codex）的：说“只有它”，不说“1 个 harness”
  const only = device.kind === 'ssh' && device.mode === 'single' ? harnesses[0] : undefined
  return (
    <span
      className="devp-cell devp-has"
      data-peer={device.kind === 'ssh' ? (only ? 'codex' : 'service') : undefined}
    >
      <span className="devp-sub">
        {only
          ? t('devices.peer.only', { name: only.name })
          : t('devices.harnessCount', { count: harnesses.length })}
      </span>
      <span className="devp-chips">
        {harnesses.slice(0, SHOWN).map((harness) => (
          <span
            key={harness.id}
            className={downHarness(device, harness.id) ? 'chip off' : 'chip'}
            title={chipTitle(device, harness.id, t)}
            data-harness={harness.id}
          >
            {harness.badge}
          </span>
        ))}
        {folded.length > 0 ? (
          <span
            className="devp-more mono"
            title={folded.map((harness) => harness.name).join(t('list.comma'))}
          >
            +{folded.length}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/** 忙不忙：几个在等人、几个在跑；都没有就是闲着。没连上的设备说不出来，空着 */
function Busy({ online, activity }: { online: boolean; activity: DeviceActivity | undefined }) {
  const t = useT()
  if (!online || !activity) return <span className="devp-cell devp-busy" />
  const { running, waiting } = activity
  return (
    <span className="devp-cell devp-busy" data-running={running} data-waiting={waiting}>
      {/* 等人的排在前面：它是这一行上唯一要人动手的事 */}
      {waiting > 0 ? (
        <span className="pill wait">{t('devices.busy.waiting', { count: waiting })}</span>
      ) : null}
      {running > 0 ? (
        <span className="devp-running">
          <i className="st run" />
          {t('devices.busy.running', { count: running })}
        </span>
      ) : null}
      {running === 0 && waiting === 0 ? (
        <span className="dim">{t('devices.busy.idle')}</span>
      ) : null}
    </span>
  )
}

export function DeviceRow({ deviceId, focus, onOpen }: DeviceRowProps) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const activity = useKey<DeviceActivity>(keys.activity(deviceId))
  const t = useT()
  const now = useNow()
  const row = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focus) row.current?.focus()
  }, [focus])
  if (!device) return null

  const online = device.connection === 'online'
  const last = activity?.lastActiveAt ?? null
  return (
    <li className="devp-item" style={wireStyle(device.wire)} data-device={deviceId}>
      <button
        ref={row}
        type="button"
        className={online ? 'devp-row' : 'devp-row off'}
        onClick={onOpen}
      >
        <i className={online ? 'wire-sq' : 'wire-sq off'} />
        <span className="devp-cell devp-who">
          <span className="devp-name ell">{t.text(device.name)}</span>
          <span className="devp-sub mono ell">{device.host}</span>
        </span>
        <span className="devp-cell devp-state">
          <StatePill device={device} />
          {/* 唯一一种要在行上留记号的：服务比应用的旧、还没换成（本机是这次没换成，远程是还没升级或者在等着换）。
              只是个记号，原因和办法在详情里 */}
          {staleService(device) || staleRemote(device) ? (
            <span
              className="devp-flag"
              role="img"
              data-flag="service"
              title={t(device.kind === 'local' ? 'service.flag' : 'service.remote.flag')}
              aria-label={t(device.kind === 'local' ? 'service.flag' : 'service.remote.flag')}
            >
              <Notice />
            </span>
          ) : null}
        </span>
        <Harnesses device={device} />
        <Busy online={online} activity={activity} />
        <span className="devp-cell devp-when mono" title={t('devices.lastActive')}>
          {last === null ? '—' : ago(last, now, t)}
        </span>
        <Forward />
      </button>
    </li>
  )
}
