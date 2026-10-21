// 设置页“按 harness 开关”：一张树表，每台设备一行（能展开），下面是它的各 harness；三列多选框：任务卡、内置浏览器、Computer Use。
// 只存 harness 这一层，设备那一格是算出来的三态（harness-switches-logic.ts），点它把这台设备的整列一起设。
// 浏览器、Computer Use 存在桌面端（核心的 device.tools.set，带 harness 只改那一个），离线也改得了；
// 任务卡存在设备上（设备设置 harness.<id>.taskCards），走现有的设备设置写入，要连着才改得了。
// 写入要带设备设置的版本号：开着这张表时订阅能管理的设备的设置（replica.openManage），核心也靠这份订阅给出任务卡的现值。
import { type DeviceView, keys, type SettingsSnapshotView, taskCardsSettingKey } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKeys, useServices } from '../app/services.tsx'
import { useDevices } from '../composer/useNewPlace.ts'
import type { MessageKey, Translator } from '../i18n/index.ts'
import {
  type CellState,
  columnShown,
  deviceCell,
  editable,
  harnessCell,
  harnessRows,
  nextForDevice,
  SWITCH_COLUMNS,
  type SwitchColumn,
} from './harness-switches-logic.ts'

const TITLES: Record<SwitchColumn, MessageKey> = {
  taskCards: 'switches.col.taskCards',
  browser: 'switches.col.browser',
  computer: 'switches.col.computer',
}

export function HarnessSwitches() {
  const t = useT()
  const { channel, replica } = useServices()
  const devices = useDevices()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  /** 正在改的设备：一次只改一处，改完再点下一处 */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const managed = devices.filter((device) => device.manageable).map((device) => device.id)
  const snapshots = useKeys<SettingsSnapshotView>(managed.map(keys.manageSnapshot))
  const snapshotOf = (deviceId: string) => snapshots[managed.indexOf(deviceId)]

  // 能管理的设备都订阅着设置：任务卡的现值和写入用的版本号都从这里来
  const managedKey = managed.join('\n')
  useEffect(() => {
    const stops = managedKey ? managedKey.split('\n').map((id) => replica.openManage(id)) : []
    return () => {
      for (const stop of stops) stop()
    }
  }, [replica, managedKey])

  const columns = SWITCH_COLUMNS.filter((column) => columnShown(devices, column))

  const run = (deviceId: string, work: () => Promise<unknown>) => {
    setFailure(null)
    setBusy((now) => new Set(now).add(deviceId))
    work()
      .catch((error: unknown) => setFailure(t('switches.failed', { reason: reasonOf(error, t) })))
      .finally(() =>
        setBusy((now) => {
          const next = new Set(now)
          next.delete(deviceId)
          return next
        }),
      )
  }

  /** 改一格。harness 是 null 时是设备那一格：整列 */
  const flip = (device: DeviceView, harness: string | null, column: SwitchColumn, on: boolean) => {
    if (column !== 'taskCards') {
      run(device.id, () =>
        channel.command('device.tools.set', {
          deviceId: device.id,
          ...(harness === null ? {} : { harness }),
          [column]: on,
        }),
      )
      return
    }
    const snapshot = snapshotOf(device.id)
    if (!snapshot) return
    const targets =
      harness === null
        ? harnessRows(device)
            .filter((row) => row.switches.taskCards !== null)
            .map((row) => row.id)
        : [harness]
    run(device.id, () =>
      channel.command('device.settings.write', {
        deviceId: device.id,
        expectedVersion: snapshot.version,
        edits: targets.map((id) => ({ key: taskCardsSettingKey(id), value: on })),
      }),
    )
  }

  /** 不知道任务卡现值时为什么不知道 */
  const unknownWhy = (device: DeviceView): MessageKey => {
    if (device.connection !== 'online') return 'switches.unknown.offline'
    if (!device.manageable || snapshotOf(device.id)) return 'switches.unknown.old'
    return 'switches.unknown.loading'
  }

  if (devices.length === 0) {
    return (
      <section className="set-block hsw">
        <p className="set-para">{t('switches.empty')}</p>
      </section>
    )
  }

  return (
    <section className="set-block hsw" data-slot="harness-switches-table">
      <p className="set-para">{t('switches.note')}</p>
      <div className="hsw-scroll">
        <table className="hsw-table">
          <thead>
            <tr>
              <th scope="col">{t('switches.col.name')}</th>
              {columns.map((column) => (
                <th key={column} scope="col" data-col={column}>
                  {t(TITLES[column])}
                </th>
              ))}
            </tr>
          </thead>
          {devices.map((device) => {
            const name = t.text(device.name)
            const open = !collapsed.has(device.id)
            const rows = harnessRows(device)
            const offline = device.connection !== 'online'
            const toggle = () =>
              setCollapsed((now) => {
                const next = new Set(now)
                if (open) next.add(device.id)
                else next.delete(device.id)
                return next
              })
            return (
              <tbody key={device.id} data-device={device.id} data-online={!offline}>
                <tr className="hsw-device">
                  <th scope="row">
                    <button
                      type="button"
                      className="hsw-fold"
                      aria-expanded={open}
                      aria-label={t(open ? 'switches.collapse' : 'switches.expand', { name })}
                      disabled={rows.length === 0}
                      onClick={toggle}
                    >
                      <span className="hsw-caret" aria-hidden="true" />
                      <span className="hsw-name">{name}</span>
                      {offline ? <span className="hsw-off">{t('switches.offline')}</span> : null}
                    </button>
                  </th>
                  {columns.map((column) => {
                    const state = deviceCell(device, column)
                    return (
                      <td key={column} data-col={column}>
                        <Cell
                          state={state}
                          label={t('switches.cell.device', { name, column: t(TITLES[column]) })}
                          locked={busy.has(device.id) || !editable(device, column, state)}
                          why={state === 'unknown' ? t(unknownWhy(device)) : null}
                          onFlip={() => flip(device, null, column, nextForDevice(state))}
                        />
                      </td>
                    )
                  })}
                </tr>
                {open
                  ? rows.map((row) => (
                      <tr key={row.id} className="hsw-harness" data-harness={row.id}>
                        <th scope="row">
                          <span className="hsw-name">{row.name}</span>
                        </th>
                        {columns.map((column) => {
                          const state = harnessCell(row.switches, column)
                          return (
                            <td key={column} data-col={column}>
                              <Cell
                                state={state}
                                label={t('switches.cell', {
                                  name: `${name} · ${row.name}`,
                                  column: t(TITLES[column]),
                                })}
                                locked={busy.has(device.id) || !editable(device, column, state)}
                                why={state === 'unknown' ? t(unknownWhy(device)) : null}
                                onFlip={() => flip(device, row.id, column, state !== 'on')}
                              />
                            </td>
                          )
                        })}
                      </tr>
                    ))
                  : null}
              </tbody>
            )
          })}
        </table>
      </div>
      {failure ? (
        <p className="set-para err" role="alert">
          {failure}
        </p>
      ) : null}
      <ColumnNotes t={t} columns={columns} />
    </section>
  )
}

/** 一格多选框。不知道现值的是一条横线，鼠标停上去说为什么 */
function Cell({
  state,
  label,
  locked,
  why,
  onFlip,
}: {
  state: CellState
  label: string
  locked: boolean
  why: string | null
  onFlip(): void
}) {
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = state === 'mixed'
  }, [state])
  if (state === 'unknown') {
    return (
      <span
        className="hsw-unknown"
        data-state="unknown"
        role="img"
        aria-label={why ? `${label} — ${why}` : label}
        title={why ?? undefined}
      >
        –
      </span>
    )
  }
  return (
    <input
      ref={box}
      type="checkbox"
      className="hsw-box"
      data-state={state}
      aria-label={label}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      checked={state === 'on'}
      disabled={locked}
      onChange={onFlip}
    />
  )
}

function ColumnNotes({ t, columns }: { t: Translator; columns: readonly SwitchColumn[] }) {
  return (
    <div className="hsw-notes">
      <p className="set-note">{t('switches.note.taskCards')}</p>
      {columns.some((column) => column !== 'taskCards') ? (
        <p className="set-note">{t('switches.note.tools')}</p>
      ) : null}
    </div>
  )
}
