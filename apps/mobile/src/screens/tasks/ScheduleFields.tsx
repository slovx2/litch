// 表单里的日程一块：多久一次的一排、按种类出的几栏（时刻、星期、几号、间隔……）、时区、
// 底下一行“下一次在…”的预览。表单的样子和校验、预览都用桌面界面那一份纯逻辑（packages/ui/src/tasks/form.ts、
// preview.ts），这里只管手机上怎么画：数字栏敲的是字，空着或不是整数时交给 checkForm 说；时刻失去焦点时整理成 HH:MM。
import type { TaskWeekday } from '@litch/core'
import { type ReactNode, useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { WEEKDAYS, whenText } from '../../../../../packages/ui/src/tasks/describe.ts'
import {
  type FormField,
  type FormProblems,
  REPEATS,
  type TaskForm,
  toggleDay,
} from '../../../../../packages/ui/src/tasks/form.ts'
import type { Preview } from '../../../../../packages/ui/src/tasks/preview.ts'
import { PickerSheet } from '../../detail/composer/PickerSheet'
import { useT } from '../../ui/i18n'
import { Chip, Field, Row } from '../../ui/kit/controls'
import { Prompt } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { numberOf, textOf, tidyTime } from './time'
import { zoneChoices } from './zones'

const DEVICE = '\u0000device'
const OTHER = '\u0000other'

export function ScheduleFields({
  form,
  onChange,
  problems,
  localZone,
  originalZone,
  editing,
  preview,
  now,
}: {
  form: TaskForm
  onChange(patch: Partial<TaskForm>): void
  problems: FormProblems
  /** 手机所在的时区 */
  localZone: string
  /** 编辑时任务原来的时区 */
  originalZone: string | null
  /** 编辑：没有“设备的时区”这一档（任务已经有自己的时区了） */
  editing: boolean
  preview: Preview
  now: number
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const [zonePicking, setZonePicking] = useState(false)
  const [zoneTyping, setZoneTyping] = useState(false)
  const bad = (field: FormField) => {
    const key = problems[field]
    return key ? t(key) : undefined
  }
  const [date = '', clock = ''] = form.at.split('T')
  const timeField = (
    value: string,
    set: (text: string) => void,
    field: FormField,
    testID: string,
  ) => (
    <Field
      label={t('tasks.form.time')}
      value={value}
      onChangeText={set}
      onEndEditing={() => {
        const tidied = tidyTime(value)
        if (tidied && tidied !== value) set(tidied)
      }}
      keyboardType="numbers-and-punctuation"
      placeholder="09:00"
      error={bad(field)}
      testID={testID}
    />
  )
  const dayChips = (days: TaskWeekday[], set: (days: TaskWeekday[]) => void) => (
    <View style={styles.chips}>
      {WEEKDAYS.map((day) => (
        <Chip
          key={day}
          label={t(`tasks.dayName.${day}`)}
          on={days.includes(day)}
          onPress={() => set(toggleDay(days, day))}
          testID={`task:day:${day}`}
        />
      ))}
    </View>
  )
  const numberField = (field: 'monthDay' | 'hours' | 'minute' | 'minutes', label: string) => (
    <Field
      label={label}
      value={textOf(form[field])}
      onChangeText={(text) => onChange({ [field]: numberOf(text) })}
      keyboardType="number-pad"
      error={bad(field)}
      testID={`task:${field}`}
    />
  )
  const daysError = bad('days')

  let fields: ReactNode = null
  switch (form.repeat) {
    case 'daily':
    case 'weekdays':
      fields = timeField(form.time, (time) => onChange({ time }), 'time', 'task:time')
      break
    case 'weekly':
      fields = (
        <>
          <Text style={[styles.label, { color: c.ink2 }]}>{t('tasks.form.days')}</Text>
          {dayChips(form.days, (days) => onChange({ days }))}
          {daysError ? <Text style={[styles.hint, { color: c.err }]}>{daysError}</Text> : null}
          {timeField(form.time, (time) => onChange({ time }), 'time', 'task:time')}
        </>
      )
      break
    case 'monthly':
      fields = (
        <>
          {numberField('monthDay', t('tasks.form.monthDay'))}
          <Text style={[styles.hint, { color: c.ink3 }]}>{t('timed.monthDay.note')}</Text>
          {timeField(form.time, (time) => onChange({ time }), 'time', 'task:time')}
        </>
      )
      break
    case 'hourly': {
      const allDays = form.hourlyDays.length === 0
      fields = (
        <>
          {numberField('hours', t('tasks.form.hours'))}
          {numberField('minute', t('tasks.form.minute'))}
          <View style={styles.switchRow}>
            <Text style={[styles.switchText, { color: c.ink }]}>{t('tasks.form.allDays')}</Text>
            <Switch
              testID="task:allDays"
              value={allDays}
              onValueChange={(value) =>
                onChange({ hourlyDays: value ? [] : ['MO', 'TU', 'WE', 'TH', 'FR'] })
              }
            />
          </View>
          {allDays ? null : dayChips(form.hourlyDays, (hourlyDays) => onChange({ hourlyDays }))}
        </>
      )
      break
    }
    case 'interval':
      fields = numberField('minutes', t('tasks.form.minutes'))
      break
    case 'once':
      fields = (
        <>
          <Field
            label={t('timed.date')}
            value={date}
            onChangeText={(text) => onChange({ at: `${text}T${clock}` })}
            keyboardType="numbers-and-punctuation"
            placeholder="2026-10-20"
            error={bad('at')}
            testID="task:date"
          />
          {timeField(clock, (text) => onChange({ at: `${date}T${text}` }), 'at', 'task:onceTime')}
        </>
      )
      break
  }

  const previewText =
    preview.kind === 'at'
      ? preview.estimated
        ? t('timed.preview.estimated', { when: whenText(preview.ms, now, t) })
        : t('tasks.form.preview', { when: whenText(preview.ms, now, t) })
      : preview.kind === 'none'
        ? t('tasks.form.previewNone')
        : t('tasks.form.previewUnknown')
  const zoneLabel = (zone: string | null) =>
    zone === null
      ? t('tasks.form.deviceZone')
      : zone === localZone
        ? t('timed.zone.local', { zone })
        : zone === originalZone
          ? t('timed.zone.task', { zone })
          : zone
  const zones = zoneChoices(localZone, originalZone, form.timezone)
  return (
    <View>
      <View style={[styles.chips, styles.pad]}>
        {REPEATS.map((repeat) => (
          <Chip
            key={repeat}
            label={t(`tasks.repeat.${repeat}`)}
            on={form.repeat === repeat}
            onPress={() => onChange({ repeat })}
            testID={`task:type:${repeat}`}
          />
        ))}
      </View>
      <View style={[styles.pad, styles.fields]}>{fields}</View>
      <Row
        title={t('tasks.form.timezone')}
        detail={zoneLabel(form.timezone)}
        testID="task:timezone"
        onPress={() => setZonePicking(true)}
      />
      {problems.timezone ? (
        <Text style={[styles.preview, { color: c.err }]}>{t(problems.timezone)}</Text>
      ) : null}
      <Text
        testID="task:preview"
        style={[
          styles.preview,
          { color: preview.kind === 'at' ? c.ink : c.ink3, fontFamily: theme.font.mono },
        ]}
      >
        {previewText}
      </Text>
      <PickerSheet
        visible={zonePicking}
        title={t('tasks.form.timezone')}
        value={form.timezone ?? DEVICE}
        search={t('composer.modelSearch')}
        options={[
          ...(editing ? [] : [{ id: DEVICE, title: zoneLabel(null) }]),
          ...zones.map((zone) => ({ id: zone, title: zoneLabel(zone) })),
          { id: OTHER, title: t('tasks.form.otherZone') },
        ]}
        onPick={(id) => {
          setZonePicking(false)
          if (id === OTHER) setZoneTyping(true)
          else onChange({ timezone: id === DEVICE ? null : id })
        }}
        onClose={() => setZonePicking(false)}
        testID="task:zones"
      />
      <Prompt
        visible={zoneTyping}
        title={t('tasks.form.timezone')}
        initial={form.timezone ?? ''}
        placeholder={t('tasks.form.zonePlaceholder')}
        submitLabel={t('form.confirm')}
        onSubmit={(zone) => onChange({ timezone: zone.trim() })}
        onClose={() => setZoneTyping(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 6 },
  fields: { gap: 12, paddingTop: 6, paddingBottom: 12 },
  label: { fontSize: 13, fontWeight: '500' },
  hint: { fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchText: { fontSize: 15 },
  preview: { fontSize: 13, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 10 },
})
