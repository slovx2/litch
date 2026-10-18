// 设备详情里的“用这台电脑的能力”：两个开关，这台设备上的会话能不能用这台桌面端的内置浏览器、Computer Use（决 190）。
// 开关存在桌面端、按设备记（核心的 device.tools.set），默认浏览器开、Computer Use 关；用的时候才查，
// 关着的时候模型的调用当场失败、被告知来这里打开。这台桌面执行不了的那一项（DeviceView.tools 里是 null）不出开关。
// 远程设备的 Computer Use 多一句说明：那台机器上的代理操作的是这台 Mac，没有“始终允许”。
// Computer Use 还要这台 Mac 给两项系统权限：知道没给全时开关下面说一句，并能直接去设置页的 Computer Use 那一组。
// 这里不为看一眼去拉起助手，只问在跑的那个、或者这次运行里上一次问到的（computer-bridge.ts 的 status(false)）。
// 远程设备在这一组里还多一行“操作这台电脑（命令与文件）”（08 号设计，machine/MachineAccess.tsx）。
import type { DeviceView } from '@litch/core'
import { useEffect, useState } from 'react'
import { requestSettings } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { MachineAccess } from '../machine/MachineAccess.tsx'
import { type ComputerUseState, computerBridge } from '../settings/computer-bridge.ts'
import { deviceHint } from '../settings/tools-logic.ts'

type Which = 'browser' | 'computer'

const ROWS: { which: Which; title: MessageKey; note: MessageKey }[] = [
  { which: 'browser', title: 'devices.tools.browser', note: 'devices.tools.browser.note' },
  { which: 'computer', title: 'devices.tools.computer', note: 'devices.tools.computer.note' },
]

export function ToolSwitches({ device }: { device: DeviceView }) {
  const { channel } = useServices()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const rows = ROWS.filter((row) => device.tools[row.which] !== null)
  const permitted = usePermissions(device.tools.computer !== null)
  if (rows.length === 0 && !device.machine) return null
  const remote = device.kind === 'ssh'

  const flip = (which: Which, on: boolean) => {
    setBusy(true)
    setFailure(null)
    channel
      .command('device.tools.set', { deviceId: device.id, [which]: on })
      .catch((error: unknown) =>
        setFailure(t('devices.tools.failed', { reason: reasonOf(error, t) })),
      )
      .finally(() => setBusy(false))
  }

  return (
    <section className="mng-sec" data-sec="tools">
      <div className="mng-sec-head">
        <h2>{t('devices.tools')}</h2>
      </div>
      <div className="devp-note">{t('devices.tools.note')}</div>
      {rows.map(({ which, title, note }) => {
        const on = device.tools[which] === true
        const id = `tool-${device.id}-${which}`
        return (
          <div key={which} className="mng-row" data-tool={which} data-on={on}>
            <div className="mng-row-text">
              <div className="mng-row-head">
                <label className="mng-row-title" htmlFor={id}>
                  {t(title)}
                </label>
              </div>
              <span className="form-note">
                {t(note)}
                {which === 'computer' && remote ? ` ${t('devices.tools.computer.remote')}` : null}
              </span>
              {which === 'computer' && permitted !== undefined ? (
                <PermissionHint state={permitted} />
              ) : null}
            </div>
            <div className="mng-row-ctl">
              <button
                id={id}
                type="button"
                role="switch"
                className="switch"
                aria-checked={on}
                disabled={busy}
                onClick={() => flip(which, !on)}
              >
                <i />
              </button>
            </div>
          </div>
        )
      })}
      <MachineAccess device={device} busy={busy} />
      {failure ? (
        <div className="devp-note err" role="alert">
          {failure}
        </div>
      ) : null}
    </section>
  )
}

/**
 * 这台 Mac 给没给 Computer Use 两项系统权限。undefined：这台桌面没有 Computer Use（不是 macOS、在普通浏览器里），
 * 或者这台设备上没有这一项；pending：外壳还没答（这时什么都不说，免得一闪）。不拉起助手
 */
function usePermissions(wanted: boolean): ComputerUseState | null | 'pending' | undefined {
  const bridge = computerBridge()
  const [state, setState] = useState<ComputerUseState | null | 'pending'>('pending')
  useEffect(() => {
    if (!bridge || !wanted) return
    let dropped = false
    bridge.status(false).then(
      (next) => {
        if (!dropped) setState(next)
      },
      () => {},
    )
    return () => {
      dropped = true
    }
  }, [bridge, wanted])
  return bridge && wanted ? state : undefined
}

/** 开关下面的一句：没给全（知道的）说清楚，没问过的淡淡提一句；都给了不说。后面是去设置页那一组的按钮 */
function PermissionHint({ state }: { state: ComputerUseState | null | 'pending' }) {
  const t = useT()
  const hint = state === 'pending' ? null : deviceHint(state)
  if (!hint) return null
  return (
    <span
      className={hint === 'missing' ? 'form-note warn tool-perm' : 'form-note tool-perm'}
      data-perm={hint}
    >
      {t(hint === 'missing' ? 'devices.tools.computer.missing' : 'devices.tools.computer.unknown')}{' '}
      <button
        type="button"
        className="linkish"
        data-act="computer-settings"
        onClick={() => requestSettings('computer')}
      >
        {t('devices.tools.computer.check')}
      </button>
    </span>
  )
}
