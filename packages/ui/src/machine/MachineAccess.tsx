// 设备详情“用这台电脑的能力”那一组里的一行：远程设备能不能操作这台电脑（命令与文件，08 号设计 3.1–3.3、4.1）。
// 只在远程设备上有（DeviceView.machine 不是 null）。默认关；打开要再确认一次，写明后果。
// 打开之后下面展开三样：审批方式（三选一，选“不确认”再确认一次，之后一直标着）、访问范围（三选一：
// 禁止常用敏感位置可以展开看名单，自定义展开路径列表、能加能删）、最近的操作（MachineLog.tsx）。
// 设置要简单：每样只有一排选项，不堆说明。
import type { DeviceView, MachineAccessMode, MachineAccessView, MachineApproval } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { reasonOf } from '../app/errors.ts'
import { Fold } from '../app/Fold.tsx'
import { useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { addPath, removePath } from './logic.ts'
import { MachineLog } from './MachineLog.tsx'

const APPROVALS: { id: MachineApproval; text: MessageKey }[] = [
  { id: 'session', text: 'machine.approval.session' },
  { id: 'each', text: 'machine.approval.each' },
  { id: 'never', text: 'machine.approval.never' },
]

const MODES: { id: MachineAccessMode; text: MessageKey }[] = [
  { id: 'sensitive', text: 'machine.access.sensitive' },
  { id: 'open', text: 'machine.access.open' },
  { id: 'custom', text: 'machine.access.custom' },
]

/** 要再确认一次的两件事：打开开关、选“不确认” */
type Asking = 'enable' | 'never' | null

export function MachineAccess({ device, busy }: { device: DeviceView; busy: boolean }) {
  const { channel } = useServices()
  const t = useT()
  const [asking, setAsking] = useState<Asking>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const machine = device.machine
  if (!machine) return null
  const name = t.text(device.name)
  const id = `tool-${device.id}-machine`

  const run = (work: Promise<unknown>) => {
    setSaving(true)
    setFailure(null)
    work
      .catch((error: unknown) => setFailure(t('machine.failed', { reason: reasonOf(error, t) })))
      .finally(() => setSaving(false))
  }
  const flip = (on: boolean) =>
    run(channel.command('device.tools.set', { deviceId: device.id, machine: on }))
  const setApproval = (approval: MachineApproval) =>
    run(channel.command('device.machine.set', { deviceId: device.id, approval }))
  const setAccess = (access: { mode: MachineAccessMode; custom?: string[] }) =>
    run(channel.command('device.machine.set', { deviceId: device.id, access }))

  const never = machine.enabled && machine.approval === 'never'
  return (
    <div
      className="mng-row mach-row"
      data-tool="machine"
      data-on={machine.enabled}
      data-never={never || undefined}
    >
      <div className="mng-row-text">
        <div className="mng-row-head">
          <label className="mng-row-title" htmlFor={id}>
            {t('machine.title')}
          </label>
          {never ? <span className="pill err mach-never">{t('machine.never.badge')}</span> : null}
        </div>
        <span className="form-note">{t('machine.note')}</span>
      </div>
      <div className="mng-row-ctl">
        <button
          id={id}
          type="button"
          role="switch"
          className="switch"
          aria-checked={machine.enabled}
          disabled={busy || saving}
          onClick={() => (machine.enabled ? flip(false) : setAsking('enable'))}
        >
          <i />
        </button>
      </div>
      {machine.enabled ? (
        <MachineOptions
          deviceId={device.id}
          deviceName={name}
          machine={machine}
          disabled={saving}
          onApproval={(approval) =>
            approval === 'never' ? setAsking('never') : setApproval(approval)
          }
          onAccess={setAccess}
        />
      ) : null}
      {failure ? (
        <div className="mng-row-note err" role="alert">
          {failure}
        </div>
      ) : null}
      {asking === 'enable' ? (
        <Confirm
          title={t('machine.enable.title', { device: name })}
          note={t('machine.enable.note', { device: name })}
          yes={t('machine.enable.yes')}
          no={t('permission.confirm.no')}
          onYes={() => {
            setAsking(null)
            flip(true)
          }}
          onClose={() => setAsking(null)}
        />
      ) : asking === 'never' ? (
        <Confirm
          title={t('machine.never.title')}
          note={t('machine.never.note', { device: name })}
          yes={t('machine.never.yes')}
          no={t('permission.confirm.no')}
          onYes={() => {
            setAsking(null)
            setApproval('never')
          }}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </div>
  )
}

interface OptionsProps {
  deviceId: string
  deviceName: string
  machine: MachineAccessView
  disabled: boolean
  onApproval(approval: MachineApproval): void
  onAccess(access: { mode: MachineAccessMode; custom?: string[] }): void
}

/** 开关打开之后展开的三样：审批、访问范围、最近的操作 */
function MachineOptions({
  deviceId,
  deviceName,
  machine,
  disabled,
  onApproval,
  onAccess,
}: OptionsProps) {
  const t = useT()
  const { mode, custom } = machine.access
  return (
    <div className="mach-opts">
      <div className="mach-opt" data-opt="approval">
        <span className="mach-opt-name" id={`mach-approval-${deviceId}`}>
          {t('machine.approval')}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: 沿用别处那排按钮的写法（.seg），用 fieldset 会带出浏览器自己的边框和排版 */}
        <div
          className="seg"
          role="group"
          aria-labelledby={`mach-approval-${deviceId}`}
          data-choice="approval"
        >
          {APPROVALS.map(({ id, text }) => (
            <button
              key={id}
              type="button"
              aria-pressed={machine.approval === id}
              data-value={id}
              disabled={disabled}
              onClick={() => machine.approval !== id && onApproval(id)}
            >
              {t(text)}
            </button>
          ))}
        </div>
      </div>
      {machine.approval === 'never' ? (
        // 选了“不确认”：一直标着，就在这一排下面
        <div className="mach-sub mach-warn" role="status">
          {t('machine.never.warn', { device: deviceName })}
        </div>
      ) : null}
      <div className="mach-opt" data-opt="access">
        <span className="mach-opt-name" id={`mach-access-${deviceId}`}>
          {t('machine.access')}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: 沿用别处那排按钮的写法（.seg），用 fieldset 会带出浏览器自己的边框和排版 */}
        <div
          className="seg"
          role="group"
          aria-labelledby={`mach-access-${deviceId}`}
          data-choice="access"
        >
          {MODES.map(({ id, text }) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              data-value={id}
              disabled={disabled}
              onClick={() => mode !== id && onAccess({ mode: id })}
            >
              {t(text)}
            </button>
          ))}
        </div>
      </div>
      {mode === 'sensitive' ? (
        <PresetList deviceId={deviceId} presets={machine.presets} />
      ) : mode === 'custom' ? (
        <CustomList
          paths={custom}
          disabled={disabled}
          onChange={(next) => onAccess({ mode: 'custom', custom: next })}
        />
      ) : null}
      <MachineLog deviceId={deviceId} />
    </div>
  )
}

/** 内置名单：默认收着，点开看全 */
function PresetList({ deviceId, presets }: { deviceId: string; presets: string[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const listId = `mach-presets-${deviceId}`
  return (
    <div className="mach-sub" data-sub="presets">
      <Fold open={open} onToggle={() => setOpen(!open)} controls={listId} className="mach-fold">
        {t('machine.access.presets', { count: presets.length })}
      </Fold>
      {open ? (
        <ul className="mach-paths" id={listId}>
          {presets.map((path) => (
            <li key={path} className="mach-path">
              <span className="mono ell">{path}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** 自定义的禁止位置：一行一个，能删；最下面一行能加 */
function CustomList({
  paths,
  disabled,
  onChange,
}: {
  paths: string[]
  disabled: boolean
  onChange(next: string[]): void
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<'empty' | 'dup' | null>(null)
  const add = () => {
    const result = addPath(paths, draft)
    if ('problem' in result) {
      setProblem(result.problem)
      return
    }
    setProblem(null)
    setDraft('')
    onChange(result.list)
  }
  return (
    <div className="mach-sub" data-sub="custom">
      {paths.length > 0 ? (
        <ul className="mach-paths">
          {paths.map((path) => (
            <li key={path} className="mach-path" data-path={path}>
              <span className="mono ell">{path}</span>
              <button
                type="button"
                className="mini"
                disabled={disabled}
                aria-label={t('machine.access.removeOne', { path })}
                onClick={() => onChange(removePath(paths, path))}
              >
                {t('machine.access.remove')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mach-empty">{t('machine.access.none')}</div>
      )}
      <div className="mach-add">
        <input
          className="req-input mono"
          value={draft}
          placeholder={t('machine.access.placeholder')}
          aria-label={t('machine.access.addLabel')}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value)
            setProblem(null)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            // 这一页自己也听 Esc（回到设备列表）：在这里按 Esc 只是清掉没加的字
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft('')
              setProblem(null)
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="btn" disabled={disabled} onClick={add}>
          {t('machine.access.add')}
        </button>
      </div>
      {problem ? (
        <div className="mng-row-note err" role="alert">
          {t(problem === 'dup' ? 'machine.access.dup' : 'machine.access.empty')}
        </div>
      ) : null}
    </div>
  )
}
