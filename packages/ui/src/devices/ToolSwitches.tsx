// 设备详情里的“用这台电脑的能力”：两个开关，这台设备上的会话能不能用这台桌面端的内置浏览器、Computer Use（决 190）。
// 开关存在桌面端、按设备记（核心的 device.tools.set），默认浏览器开、Computer Use 关；用的时候才查，
// 关着的时候模型的调用当场失败、被告知来这里打开。这台桌面执行不了的那一项（DeviceView.tools 里是 null）不出开关。
// 远程设备的 Computer Use 多一句说明：那台机器上的模型能操作这台电脑，没有“始终允许”。
import type { DeviceView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'

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
  if (rows.length === 0) return null
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
      {failure ? (
        <div className="devp-note err" role="alert">
          {failure}
        </div>
      ) : null}
    </section>
  )
}
