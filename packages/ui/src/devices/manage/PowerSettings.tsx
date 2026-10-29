// 电源开关立即写入，仍以服务端快照为准；写入失败时保留原值并说明原因。
import {
  type DevicePowerView,
  keys,
  type SettingSpecView,
  type SettingsSnapshotView,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useKey, useServices } from '../../app/services.tsx'
import { PLUGGED_POWER_SETTING, powerStatusLine } from '../power-shortcut.ts'
import { Control } from './controls.tsx'

export function PowerSettings({
  deviceId,
  specs,
  snapshot,
}: {
  deviceId: string
  specs: readonly SettingSpecView[]
  snapshot: SettingsSnapshotView
}) {
  const t = useT()
  const { channel } = useServices()
  const state = useKey<DevicePowerView>(keys.managePower(deviceId))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const toggle = async (key: string, value: boolean) => {
    setBusy(true)
    setFailure(null)
    try {
      await channel.command('device.settings.write', {
        deviceId,
        expectedVersion: snapshot.version,
        edits: [{ key, value }],
      })
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {/* 状态行和组的说明对齐，正在阻止休眠用强调色、失败用出错色，和下面的开关分开 */}
      {state ? (
        <p className="mng-sec-note power-state" data-state={state.state} role="status">
          {powerStatusLine(state, snapshot.values[PLUGGED_POWER_SETTING] === true, t)}
        </p>
      ) : null}
      <div className="mng-rows" data-power-settings>
        {specs.map((spec) => (
          <div className="mng-row" data-setting={spec.key} data-type={spec.type} key={spec.key}>
            <div className="mng-row-text">
              <label className="mng-row-title" htmlFor={`power-${deviceId}-${spec.key}`}>
                {t.said(spec.title)}
              </label>
              <span className="form-note">{t.said(spec.description)}</span>
            </div>
            <div className="mng-row-ctl">
              <Control
                id={`power-${deviceId}-${spec.key}`}
                spec={spec}
                stored={snapshot.values[spec.key]}
                edit={null}
                disabled={busy}
                wrong={false}
                label={t.said(spec.title)}
                onEdit={(edit) => {
                  if (edit.kind === 'boolean') void toggle(spec.key, edit.value)
                }}
              />
            </div>
          </div>
        ))}
        {failure ? (
          <p className="form-note err" role="alert">
            {whyNot(failure, t)}
          </p>
        ) : null}
      </div>
    </>
  )
}
