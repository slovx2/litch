// 设备详情里的“用这台电脑的能力”：任务卡、内置浏览器、Computer Use 按 harness 分别开关，开关本身在设置页
// “按 harness 开关”那棵树里（settings/HarnessSwitches.tsx），这里每样一行摘要（全开、全关、只对哪几个开着），加一个去那里的链接。
// 这台桌面执行不了的那一项（DeviceView.tools 里是 null）不出。远程设备的 Computer Use 多一句说明：那台机器上的代理操作的是这台 Mac。
// Computer Use 还要这台 Mac 给两项系统权限：知道没给全时那一行下面说一句，并能直接去设置页的 Computer Use 那一组。
// 这里不为看一眼去拉起助手，只问在跑的那个、或者这次运行里上一次问到的（computer-bridge.ts 的 status(false)）。
// 远程设备在这一组里还多一行“操作这台电脑（命令与文件）”（machine/MachineAccess.tsx），它不分 harness，开关还在这里。
import type { DeviceView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { requestSettings } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import type { MessageKey, Translator } from '../i18n/index.ts'
import { MachineAccess } from '../machine/MachineAccess.tsx'
import { type ComputerUseState, computerBridge } from '../settings/computer-bridge.ts'
import {
  harnessRows,
  type Summary,
  type SwitchColumn,
  summaryOf,
} from '../settings/harness-switches-logic.ts'
import { deviceHint } from '../settings/tools-logic.ts'

const ROWS: { column: SwitchColumn; title: MessageKey }[] = [
  { column: 'taskCards', title: 'switches.col.taskCards' },
  { column: 'browser', title: 'devices.tools.browser' },
  { column: 'computer', title: 'devices.tools.computer' },
]

/** 设置页里那棵树所在的一组 */
const SWITCHES_SECTION = 'switches'

const summaryText = (summary: Summary, t: Translator): string => {
  if (summary === null) return t('switches.summary.unknown')
  if (summary.kind === 'all') return t('switches.summary.all')
  if (summary.kind === 'none') return t('switches.summary.none')
  return t('switches.summary.some', { names: summary.names.join(t('list.comma')) })
}

export function ToolSwitches({ device, reveal = false }: { device: DeviceView; reveal?: boolean }) {
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (reveal) section.current?.scrollIntoView({ block: 'start' })
  }, [reveal])
  const t = useT()
  const rows = ROWS.filter(({ column }) =>
    column === 'taskCards' ? harnessRows(device).length > 0 : device.tools[column] !== null,
  )
  const permitted = usePermissions(device.tools.computer !== null)
  if (rows.length === 0 && !device.machine) return null
  const remote = device.kind === 'ssh'

  return (
    <section className="mng-sec" data-sec="tools" ref={section}>
      <div className="mng-sec-head">
        <h2>{t('devices.tools')}</h2>
        <span className="grow" />
        {rows.length > 0 ? (
          <button
            type="button"
            className="linkish"
            data-act="tool-switches"
            onClick={() => requestSettings(SWITCHES_SECTION)}
          >
            {t('switches.go')}
          </button>
        ) : null}
      </div>
      {rows.length > 0 ? <div className="devp-note">{t('switches.detail.note')}</div> : null}
      {rows.map(({ column, title }) => {
        const summary = summaryOf(device, column)
        return (
          <div
            key={column}
            className="mng-row"
            data-tool={column}
            data-summary={summary?.kind ?? 'unknown'}
          >
            <div className="mng-row-text">
              <div className="mng-row-head">
                <span className="mng-row-title">{t(title)}</span>
                <span className="mng-sum">{summaryText(summary, t)}</span>
              </div>
              {column === 'computer' && remote ? (
                <span className="form-note">{t('devices.tools.computer.remote')}</span>
              ) : null}
              {column === 'computer' && permitted !== undefined ? (
                <PermissionHint state={permitted} />
              ) : null}
            </div>
          </div>
        )
      })}
      <MachineAccess device={device} busy={false} />
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
