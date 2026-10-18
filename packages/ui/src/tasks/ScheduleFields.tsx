// 表单里“日程”那一块：多久一次，跟着它出的那几栏（时刻、星期几、几号、隔多久、日期），时区，
// 最后一句“下一次在…”。只管显示和把改动交上去，状态在 TaskForm.tsx。
import type { TaskWeekday } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Picker, type PickerOption } from '../composer/Picker.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { viewerZone, WEEKDAYS, whenText } from './describe.ts'
import { type FormProblems, REPEATS, type TaskForm, toggleDay } from './form.ts'
import { previewOf } from './preview.ts'

interface ScheduleFieldsProps {
  form: TaskForm
  problems: FormProblems
  /** 设备那一头说这一块哪里不对（日程、时区） */
  remote: string | null
  /** 编辑已有的任务：时区没有“设备的”这一档（任务已经有自己的时区） */
  editing: boolean
  now: number
  /** 选中的设备报的时区；旧版设备服务不报是 null，预览按这台电脑估 */
  deviceZone?: string | null
  onChange(patch: Partial<TaskForm>): void
}

/** 时区选择器里“别的时区…”那一项 */
const OTHER_ZONE = '\u0000other'
/** 时区选择器里“设备的时区”那一项 */
const DEVICE_ZONE = '\u0000device'

function Days({
  days,
  wrong,
  label,
  onChange,
}: {
  days: TaskWeekday[]
  wrong: boolean
  label: string
  onChange(days: TaskWeekday[]): void
}) {
  const t = useT()
  return (
    // biome-ignore lint/a11y/useSemanticElements: 一排小按钮，没有自己的边框和标题
    <div className={wrong ? 'pickset wrong' : 'pickset'} role="group" aria-label={label}>
      {WEEKDAYS.map((day) => (
        // biome-ignore lint/a11y/useSemanticElements: 原生的复选框画不成一排小按钮
        <button
          key={day}
          type="button"
          role="checkbox"
          className="pickset-opt"
          data-day={day}
          aria-checked={days.includes(day)}
          onClick={() => onChange(toggleDay(days, day))}
        >
          {t(`tasks.dayName.${day}` as MessageKey)}
        </button>
      ))}
    </div>
  )
}

export function ScheduleFields({
  form,
  problems,
  remote,
  editing,
  now,
  deviceZone = null,
  onChange,
}: ScheduleFieldsProps) {
  const t = useT()
  const here = viewerZone()
  /** 选了“别的时区…”，正在框里写 */
  const known = [here, 'UTC']
  const [typing, setTyping] = useState(
    () => form.timezone !== null && !known.includes(form.timezone),
  )
  const problem = (key: keyof FormProblems) => {
    const which = problems[key]
    return which ? <span className="form-note err">{t(which)}</span> : null
  }
  const number = (
    id: 'monthDay' | 'minutes' | 'hours' | 'minute',
    label: MessageKey,
    min: number,
    max?: number,
  ) => (
    <div className="form-field tk-num">
      <label className="form-label" htmlFor={`tk-${id}`}>
        {t(label)}
      </label>
      <input
        id={`tk-${id}`}
        type="number"
        className={problems[id] ? 'req-input wrong' : 'req-input'}
        min={min}
        max={max}
        value={Number.isNaN(form[id]) ? '' : form[id]}
        aria-invalid={problems[id] !== undefined}
        onChange={(event) => onChange({ [id]: event.target.valueAsNumber })}
      />
      {problem(id)}
    </div>
  )
  const timed = form.repeat !== 'interval' && form.repeat !== 'hourly' && form.repeat !== 'once'

  const zoneOptions: PickerOption[] = [
    ...(editing ? [] : [{ id: DEVICE_ZONE, title: t('tasks.form.deviceZone') }]),
    { id: here, title: t('tasks.form.localZone', { zone: here }) },
    ...(here === 'UTC' ? [] : [{ id: 'UTC', title: 'UTC' }]),
    ...(form.timezone !== null && !known.includes(form.timezone) && !typing
      ? [{ id: form.timezone, title: form.timezone }]
      : []),
    { id: OTHER_ZONE, title: t('tasks.form.otherZone'), action: true },
  ]
  const preview = previewOf(form, now, deviceZone)

  return (
    <>
      <div className="tk-form-row">
        <div className="form-field">
          <span className="form-label">{t('tasks.form.repeat')}</span>
          <Picker
            kind="repeat"
            label={t('tasks.form.repeat')}
            value={form.repeat}
            options={REPEATS.map((id) => ({ id, title: t(`tasks.repeat.${id}` as MessageKey) }))}
            onPick={(id) => onChange({ repeat: id as TaskForm['repeat'] })}
          />
        </div>
        {timed ? (
          <div className="form-field">
            <label className="form-label" htmlFor="tk-time">
              {t('tasks.form.time')}
            </label>
            <input
              id="tk-time"
              type="time"
              className={problems.time ? 'req-input wrong' : 'req-input'}
              value={form.time}
              aria-invalid={problems.time !== undefined}
              onChange={(event) => onChange({ time: event.target.value })}
            />
            {problem('time')}
          </div>
        ) : null}
        {form.repeat === 'monthly' ? number('monthDay', 'tasks.form.monthDay', 1, 31) : null}
        {form.repeat === 'interval' ? number('minutes', 'tasks.form.minutes', 5) : null}
        {form.repeat === 'hourly' ? number('hours', 'tasks.form.hours', 1, 23) : null}
        {form.repeat === 'hourly' ? number('minute', 'tasks.form.minute', 0, 59) : null}
        {form.repeat === 'once' ? (
          <div className="form-field">
            <label className="form-label" htmlFor="tk-at">
              {t('tasks.form.at')}
            </label>
            <input
              id="tk-at"
              type="datetime-local"
              className={problems.at ? 'req-input wrong' : 'req-input'}
              value={form.at}
              aria-invalid={problems.at !== undefined}
              onChange={(event) => onChange({ at: event.target.value })}
            />
            {problem('at')}
          </div>
        ) : null}
      </div>
      {form.repeat === 'weekly' ? (
        <div className="form-field">
          <span className="form-label">{t('tasks.form.days')}</span>
          <Days
            days={form.days}
            wrong={problems.days !== undefined}
            label={t('tasks.form.days')}
            onChange={(days) => onChange({ days })}
          />
          {problem('days')}
        </div>
      ) : null}
      {form.repeat === 'hourly' ? (
        <div className="form-field">
          <span className="form-label">{t('tasks.form.onDays')}</span>
          <Days
            days={form.hourlyDays}
            wrong={false}
            label={t('tasks.form.onDays')}
            onChange={(hourlyDays) => onChange({ hourlyDays })}
          />
          {form.hourlyDays.length === 0 ? (
            <span className="form-note">{t('tasks.form.allDays')}</span>
          ) : null}
        </div>
      ) : null}
      <div className="form-field">
        <span className="form-label">{t('tasks.form.timezone')}</span>
        <div className="tk-zone">
          <Picker
            kind="timezone"
            label={t('tasks.form.timezone')}
            value={typing ? OTHER_ZONE : (form.timezone ?? DEVICE_ZONE)}
            options={zoneOptions}
            onPick={(id) => {
              if (id === OTHER_ZONE) {
                setTyping(true)
                return
              }
              setTyping(false)
              onChange({ timezone: id === DEVICE_ZONE ? null : id })
            }}
          />
          {typing ? (
            <input
              className={problems.timezone ? 'req-input mono wrong' : 'req-input mono'}
              value={form.timezone ?? ''}
              placeholder={t('tasks.form.zonePlaceholder')}
              aria-label={t('tasks.form.timezone')}
              aria-invalid={problems.timezone !== undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ timezone: event.target.value.trim() || null })}
            />
          ) : null}
        </div>
        {problem('timezone')}
      </div>
      {remote ? <div className="form-note err">{remote}</div> : null}
      <div className="tk-preview" data-preview={preview.kind}>
        {preview.kind === 'at'
          ? t(preview.estimated ? 'tasks.form.previewZone' : 'tasks.form.preview', {
              when: whenText(preview.ms, now, t),
            })
          : preview.kind === 'none'
            ? t('tasks.form.previewNone')
            : t('tasks.form.previewUnknown')}
      </div>
    </>
  )
}
