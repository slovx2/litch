// 新建和编辑定时任务的表单：名字、提示词、日程（ScheduleFields）、到点之后做什么（TargetFields）。
// 界面这一侧先查一遍（form.ts 的 checkForm），设备那一头再查；设备说哪一栏不对就写在那一块下面。
// 编辑时撞上别处的改动（conflict）：最新的样子核心已经发过来了，这边按它重新比一遍，提醒看一眼再存。
import { ChannelError, keys, type SessionSummary, type TaskView } from '@litch/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { reasonOf } from '../app/errors.ts'
import { Back, Close } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { blankForm, checkForm, draftOf, formOf, NAME_MAX, patchOf, type TaskForm } from './form.ts'
import { zoneKnown } from './preview.ts'
import { ScheduleFields } from './ScheduleFields.tsx'
import { placeOn, TargetFields } from './TargetFields.tsx'
import { useSchedulable } from './useSchedulable.ts'

export type FormMode =
  | { kind: 'new'; deviceId: string | null; threadId: string | null }
  | { kind: 'edit'; deviceId: string; taskId: string }

interface TaskFormPageProps {
  mode: FormMode
  /** 存好了（带着是哪个任务），或者不存了（null） */
  onDone(saved: { deviceId: string; taskId: string } | null): void
  onClose(): void
}

/** 设备说哪一块不对：按它给的字段名归到日程、目标，或者名字、提示词 */
type Area = 'name' | 'prompt' | 'schedule' | 'target' | 'other'
const areaOf = (key: string | undefined): Area => {
  if (!key) return 'other'
  if (key === 'name' || key === 'prompt') return key
  if (key.startsWith('schedule') || key === 'timezone') return 'schedule'
  if (key.startsWith('target')) return 'target'
  return 'other'
}

export function TaskFormPage({ mode, onDone, onClose }: TaskFormPageProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const now = useNow()
  const devices = useSchedulable()
  const editing = mode.kind === 'edit'
  const task = useKey<TaskView>(editing ? keys.task(mode.deviceId, mode.taskId) : keys.task('', ''))
  /** 编辑的是哪一版：存的时候带它的 revision，比出改了什么也按它 */
  const [base, setBase] = useState<TaskView | null>(null)
  const [form, setForm] = useState<TaskForm | null>(null)
  /** 点过“存”之后才把本地查出来的问题标出来，免得一打开满屏红字 */
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [remote, setRemote] = useState<{ area: Area; text: string } | null>(null)
  const name = useRef<HTMLInputElement>(null)

  // 表单一开始的样子。新建：指定了会话的在那个会话里接着发，否则建在头一台能建的设备上
  useEffect(() => {
    if (form) return
    if (mode.kind === 'edit') {
      if (!task) return
      setBase(task)
      setForm(formOf(task))
      return
    }
    const deviceId = mode.deviceId ?? devices[0]?.id
    const device = devices.find((entry) => entry.id === deviceId) ?? devices[0]
    if (!device) return
    const session = mode.threadId
      ? replica.store.get<SessionSummary>(keys.summary(device.id, mode.threadId))
      : undefined
    const harness = placeOn(device).harness ?? ''
    setForm(
      blankForm({
        deviceId: device.id,
        harness: session?.harness ?? harness,
        workspaceId: null,
        cwd: '',
        threadId: session?.id ?? null,
        now,
      }),
    )
  }, [form, mode, task, devices, replica, now])

  // 一打开焦点在名字上
  const ready = form !== null
  useEffect(() => {
    if (ready) name.current?.focus()
  }, [ready])

  // Esc 不存了。开着选择器的时候 Esc 归选择器
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onDone(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDone])

  const problems = useMemo(
    () => (form && tried ? checkForm(form, zoneKnown, editing) : {}),
    [form, tried, editing],
  )

  const change = (patch: Partial<TaskForm>) => {
    setForm((was) => (was ? { ...was, ...patch } : was))
    setRemote(null)
  }

  const save = async () => {
    if (!form || saving) return
    setTried(true)
    if (Object.keys(checkForm(form, zoneKnown, editing)).length > 0) return
    setSaving(true)
    setRemote(null)
    try {
      if (mode.kind === 'edit') {
        if (!base) return
        const patch = patchOf(base, form)
        if (patch) {
          await channel.command('tasks.update', {
            deviceId: mode.deviceId,
            taskId: mode.taskId,
            revision: base.revision,
            patch,
          })
        }
        onDone({ deviceId: mode.deviceId, taskId: mode.taskId })
      } else {
        const { task: made } = await channel.command('tasks.create', {
          deviceId: form.deviceId,
          task: draftOf(form),
        })
        onDone({ deviceId: form.deviceId, taskId: made.id })
      }
    } catch (error) {
      // 别处先改过：换成最新的那一版去比，表单上自己改的留着
      if (error instanceof ChannelError && error.code === 'conflict' && mode.kind === 'edit') {
        const latest = replica.store.get<TaskView>(keys.task(mode.deviceId, mode.taskId))
        if (latest) setBase(latest)
      }
      const key = error instanceof ChannelError ? error.key : undefined
      setRemote({ area: areaOf(key), text: reasonOf(error, t) })
    } finally {
      setSaving(false)
    }
  }

  const title = t(editing ? 'tasks.form.edit' : 'tasks.form.new')
  const head = (
    <header className="arch-head">
      <button
        type="button"
        className="ibtn"
        data-act="back"
        title={t('tasks.form.cancel')}
        aria-label={t('tasks.form.cancel')}
        onClick={() => onDone(null)}
      >
        <Back />
      </button>
      <div>
        <h1>{title}</h1>
      </div>
      <button
        type="button"
        className="ibtn"
        title={t('tasks.close')}
        aria-label={t('tasks.close')}
        onClick={onClose}
      >
        <Close />
      </button>
    </header>
  )

  if (!form) {
    // 编辑的任务还没到，或者没有能建的设备
    const missing = !editing && devices.length === 0
    return (
      <div className="arch-page tk-page" data-tasks="form">
        {head}
        <div className="arch-body">
          <div className="mng-wrap">
            <div className="devp-note" data-form-state={missing ? 'no-device' : 'loading'}>
              {missing ? t('tasks.form.noDevice') : t('tasks.loading')}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const said = (area: Area) => (remote?.area === area ? remote.text : null)
  return (
    <div className="arch-page tk-page" data-tasks="form">
      {head}
      <div className="arch-body">
        <form
          className="mng-wrap tk-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <section className="mng-sec" data-sec="what">
            <div className="form-field">
              <label className="form-label" htmlFor="tk-name">
                {t('tasks.form.name')}
              </label>
              <input
                id="tk-name"
                ref={name}
                className={problems.name || said('name') ? 'req-input wrong' : 'req-input'}
                value={form.name}
                maxLength={NAME_MAX}
                placeholder={t('tasks.form.namePlaceholder')}
                aria-invalid={problems.name !== undefined}
                autoComplete="off"
                onChange={(event) => change({ name: event.target.value })}
              />
              {problems.name ? <span className="form-note err">{t(problems.name)}</span> : null}
              {said('name') ? <span className="form-note err">{said('name')}</span> : null}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="tk-prompt">
                {t('tasks.form.prompt')}
              </label>
              <textarea
                id="tk-prompt"
                className={
                  problems.prompt || said('prompt')
                    ? 'req-input tk-area wrong'
                    : 'req-input tk-area'
                }
                value={form.prompt}
                rows={5}
                placeholder={t('tasks.form.promptPlaceholder')}
                aria-invalid={problems.prompt !== undefined}
                onChange={(event) => change({ prompt: event.target.value })}
              />
              {problems.prompt ? <span className="form-note err">{t(problems.prompt)}</span> : null}
              {said('prompt') ? <span className="form-note err">{said('prompt')}</span> : null}
            </div>
          </section>
          <section className="mng-sec" data-sec="schedule">
            <div className="mng-sec-head">
              <h2>{t('tasks.form.schedule')}</h2>
            </div>
            <ScheduleFields
              form={form}
              problems={problems}
              remote={said('schedule')}
              editing={editing}
              now={now}
              deviceZone={devices.find((entry) => entry.id === form.deviceId)?.timezone ?? null}
              onChange={change}
            />
          </section>
          <section className="mng-sec" data-sec="target">
            <div className="mng-sec-head">
              <h2>{t('tasks.form.target')}</h2>
            </div>
            <TargetFields
              form={form}
              problems={problems}
              remote={said('target')}
              editing={editing}
              devices={devices}
              onChange={change}
            />
          </section>
          <div className="tk-form-foot">
            {editing ? null : (
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={form.paused}
                  onChange={(event) => change({ paused: event.target.checked })}
                />
                {t('tasks.form.paused')}
              </label>
            )}
            <span className="grow" />
            {said('other') ? (
              <span className="form-note err" role="alert">
                {said('other')}
              </span>
            ) : null}
            <button type="button" className="btn ghost" onClick={() => onDone(null)}>
              {t('tasks.form.cancel')}
            </button>
            <button type="submit" className="btn primary" data-act="save-task" disabled={saving}>
              {saving
                ? t('tasks.form.saving')
                : t(editing ? 'tasks.form.save' : 'tasks.form.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
