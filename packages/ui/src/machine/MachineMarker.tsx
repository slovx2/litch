// 顶栏上的标记：远程设备上的会话在这台电脑上有动静。
// 一直订阅主题 machine：有在跑的进程、有找不到会话的待处理卡片时出；设了“不确认”的设备也一直标着：不确认就更要让用户看得到它在动。
// 都没有就不显示。点开是一块弹层：待处理的卡片（带倒计时）、在跑的进程（按设备分开，单个结束）、全部停。
import type {
  DeviceView,
  MachineActivityView,
  MachineProcessView,
  SessionSummary,
} from '@litch/core'
import { keys } from '@litch/core'
import { useEffect, useState } from 'react'
import { requestDevice, requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { nameOf, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { elapsed } from '../app/format.ts'
import { Icon } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { byDevice, type MachineSwitch, markerFacts, soonestFirst } from './logic.ts'
import { MachinePendingCard } from './MachineCard.tsx'

/** 主题 machine 的现值。没到之前是 undefined */
function useMachineActivity(): MachineActivityView | undefined {
  const { channel } = useServices()
  const [view, setView] = useState<MachineActivityView>()
  useEffect(
    () =>
      channel.subscribe(
        { kind: 'machine' },
        {
          snapshot: (data) => setView(data),
          delta: (ops) => {
            const last = ops.at(-1)
            if (last) setView(last.view)
          },
          // 订阅不上就当什么都没有：标记不出，不打扰
          error() {},
        },
      ),
    [channel],
  )
  return view
}

export function MachineMarker() {
  const t = useT()
  const activity = useMachineActivity()
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const devices = useKeys<DeviceView>(deviceIds.map((id) => keys.device(id)))
  const switches: MachineSwitch[] = devices.flatMap((device) =>
    device?.machine
      ? [
          {
            deviceId: device.id,
            enabled: device.machine.enabled,
            approval: device.machine.approval,
          },
        ]
      : [],
  )
  const facts = markerFacts(activity, switches)
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  const nameById = (deviceId: string) => {
    const device = devices.find((entry) => entry?.id === deviceId)
    return device ? t.text(device.name) : deviceId
  }

  // 什么都没有了就收起来：最后一张卡片答完、最后一个进程结束
  const shown = facts !== null
  useEffect(() => {
    if (!shown && open) setOpen(false)
  }, [shown, open, setOpen])
  if (!facts) return null

  const parts: string[] = []
  if (facts.running > 0) parts.push(t('machine.mark.running', { count: facts.running }))
  if (facts.pending > 0) parts.push(t('machine.mark.pending', { count: facts.pending }))
  if (parts.length === 0) parts.push(t('machine.mark.never'))
  /** 鼠标停上去、读屏读到的完整的话 */
  const said = [
    facts.running > 0
      ? facts.devices.length === 1
        ? t('machine.mark.runningBy', {
            device: nameById(facts.devices[0] ?? ''),
            count: facts.running,
          })
        : t('machine.mark.runningMany', { devices: facts.devices.length, count: facts.running })
      : null,
    facts.pending > 0 ? t('machine.mark.pendingLong', { count: facts.pending }) : null,
    ...facts.never.map((deviceId) => t('machine.never.warn', { device: nameById(deviceId) })),
  ]
    .filter(Boolean)
    .join('\n')
  const tone = facts.pending > 0 ? 'wait' : facts.running > 0 ? 'run' : 'never'

  return (
    <div className="mach-mark-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="mach-mark"
        data-tone={tone}
        data-never={facts.never.length > 0 || undefined}
        title={said}
        aria-label={said}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <Icon name="machine" small />
        <span className="mach-mark-text">{parts.join(' · ')}</span>
      </button>
      {open && activity ? (
        // 键盘事件是从里面的按钮冒上来的（上下键在按钮之间走，Esc 收起）
        <div
          className="mach-pop"
          ref={pop}
          onKeyDown={onKeyDown}
          role="dialog"
          aria-label={t('machine.pop.title')}
          data-machine-pop
        >
          <PopBody activity={activity} never={facts.never} nameById={nameById} onDone={close} />
        </div>
      ) : null}
    </div>
  )
}

function PopBody({
  activity,
  never,
  nameById,
  onDone,
}: {
  activity: MachineActivityView
  never: string[]
  nameById(deviceId: string): string
  /** 去了别处（打开会话、去设备详情）：收起弹层 */
  onDone(refocus: boolean): void
}) {
  const { channel } = useServices()
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { running, pending } = activity
  const any = running.length > 0 || pending.length > 0

  const stopAll = () => {
    setAsking(false)
    setFailure(null)
    channel
      .command('machine.stopAll', {})
      .catch((error: unknown) => setFailure(t('machine.failed', { reason: reasonOf(error, t) })))
  }

  return (
    <>
      <div className="mach-pop-head">
        <b className="grow">{t('machine.pop.title')}</b>
        {any && !asking ? (
          <button
            type="button"
            className="btn danger mach-stop-all"
            data-act="stop-all"
            onClick={() => setAsking(true)}
          >
            {t('machine.pop.stopAll')}
          </button>
        ) : null}
      </div>
      {asking ? (
        <div className="mach-pop-ask" role="alert">
          <span className="grow">
            {t('machine.pop.stopAll.ask', { running: running.length, pending: pending.length })}
          </span>
          <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
            {t('permission.confirm.no')}
          </button>
          <button type="button" className="btn danger" data-act="stop-all-yes" onClick={stopAll}>
            {t('machine.pop.stopAll')}
          </button>
        </div>
      ) : null}
      {failure ? (
        <div className="mach-pop-note err" role="alert">
          {failure}
        </div>
      ) : null}
      {never.map((deviceId) => (
        <div key={deviceId} className="mach-pop-never" data-never-device={deviceId}>
          <span className="grow">{t('machine.never.warn', { device: nameById(deviceId) })}</span>
          <button
            type="button"
            className="linkish"
            onClick={() => {
              onDone(false)
              requestDevice(deviceId)
            }}
          >
            {t('machine.pop.settings')}
          </button>
        </div>
      ))}
      {pending.length > 0 ? (
        <section className="mach-pop-sec" data-sec="pending">
          <h3>
            {t('machine.pop.pending')}
            <span className="mach-count">{pending.length}</span>
          </h3>
          <div className="mach-pop-cards">
            {soonestFirst(pending).map((entry) => (
              <MachinePendingCard key={entry.id} pending={entry} />
            ))}
          </div>
        </section>
      ) : null}
      {running.length > 0 ? (
        <section className="mach-pop-sec" data-sec="running">
          <h3>
            {t('machine.pop.running')}
            <span className="mach-count">{running.length}</span>
          </h3>
          {byDevice(running).map((group) => (
            <DeviceProcesses key={group[0]?.deviceId} group={group} onDone={onDone} />
          ))}
        </section>
      ) : null}
    </>
  )
}

/** 一台设备起的那几个进程 */
function DeviceProcesses({
  group,
  onDone,
}: {
  group: MachineProcessView[]
  onDone(refocus: boolean): void
}) {
  const t = useT()
  const first = group[0]
  const device = useKey<DeviceView>(keys.device(first?.deviceId ?? ''))
  if (!first) return null
  return (
    <div className="mach-procs" style={wireStyle(device?.wire)} data-device={first.deviceId}>
      <div className="mach-procs-dev">
        <i className="wire-sq" />
        <b>{t.text(first.deviceName)}</b>
        <span className="mach-dim">{t('machine.pop.onThis', { count: group.length })}</span>
      </div>
      <ul className="mach-proc-list">
        {group.map((entry) => (
          <ProcessRow key={entry.id} entry={entry} device={device} onDone={onDone} />
        ))}
      </ul>
    </div>
  )
}

function ProcessRow({
  entry,
  device,
  onDone,
}: {
  entry: MachineProcessView
  device: DeviceView | undefined
  onDone(refocus: boolean): void
}) {
  const { channel } = useServices()
  const t = useT()
  const ran = useElapsed(entry.startedAt) ?? 0
  const summary = useKey<SessionSummary>(keys.summary(entry.deviceId, entry.sessionId ?? ''))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const kill = () => {
    setBusy(true)
    setFailure(null)
    channel.command('machine.process.kill', { processId: entry.id }).catch((error: unknown) => {
      setBusy(false)
      setFailure(t('machine.failed', { reason: reasonOf(error, t) }))
    })
  }
  const { sessionId } = entry
  return (
    <li className="mach-proc" data-process={entry.id}>
      <div className="mach-proc-main">
        <code className="mach-proc-cmd ell" title={`${entry.cwd}\n$ ${entry.command}`}>
          {entry.command}
        </code>
        <div className="mach-proc-meta">
          {sessionId && summary ? (
            <button
              type="button"
              className="linkish ell"
              title={t('machine.pop.openSession')}
              onClick={() => {
                onDone(false)
                requestOpenSession({ deviceId: entry.deviceId, sessionId })
              }}
            >
              {t.text(summary.title)}
            </button>
          ) : (
            <span className="mach-unknown ell">
              {sessionId ? t('machine.session.gone') : t('machine.session.unknown')}
            </span>
          )}
          {entry.harness ? <span>{nameOf(device, entry.harness)}</span> : null}
          <span title={new Date(entry.startedAt).toLocaleString()}>
            {t('machine.pop.started', { time: elapsed(ran, t) })}
          </span>
        </div>
        {failure ? <div className="mach-pop-note err">{failure}</div> : null}
      </div>
      <button
        type="button"
        className="btn mach-kill"
        data-act="kill"
        disabled={busy}
        onClick={kill}
      >
        {t('machine.pop.kill')}
      </button>
    </li>
  )
}
