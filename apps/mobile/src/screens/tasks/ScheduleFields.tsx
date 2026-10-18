// 表单里的日程一块：日程种类一排、按种类出的几栏（时刻、星期、每月第几天、间隔……）、时区、
// 底下一行“下一次在…”的预览（preview.ts，和设备上排日程用的是同一套函数）。
// 敲进去的字留原文，失去焦点时把时刻整理成 HH:MM；读不成日程的那一栏标红。

import { type ReactNode, useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import type {
  TaskScheduleType,
  TaskWeekday,
} from '../../../../../packages/protocol/src/device-tasks.mjs'
import { MIN_TASK_INTERVAL_MINUTES } from '../../../../../packages/protocol/src/task-schedule.mjs'
import { PickerSheet } from '../../detail/composer/PickerSheet'
import { useT } from '../../ui/i18n'
import { Chip, Field, Row } from '../../ui/kit/controls'
import { Prompt } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import type { Preview } from './preview'
import {
  dayName,
  SCHEDULE_TYPES,
  type ScheduleForm,
  tidyTime,
  typeName,
  WEEKDAYS,
} from './schedule'
import { whenText } from './when'
import { zoneChoices, zoneOk } from './zones'

export function ScheduleFields({
  form,
  onChange,
  timezone,
  onTimezone,
  localZone,
  originalZone,
  preview,
  now,
}: {
  form: ScheduleForm
  onChange(patch: Partial<ScheduleForm>): void
  timezone: string
  onTimezone(zone: string): void
  /** 手机所在的时区 */
  localZone: string
  /** 编辑时任务原来的时区 */
  originalZone: string | null
  preview: Preview
  /** 毫秒 */
  now: number
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const [zonePicking, setZonePicking] = useState(false)
  const [zoneTyping, setZoneTyping] = useState(false)
  const [zoneError, setZoneError] = useState<string | null>(null)
  const bad = (field: keyof ScheduleForm) =>
    preview.kind === 'form' && preview.field === field
      ? t(preview.message, preview.args ?? {})
      : undefined
  const pickType = (type: TaskScheduleType) => onChange({ type })
  const toggleDay = (day: TaskWeekday) =>
    onChange({
      days: form.days.includes(day)
        ? form.days.filter((each) => each !== day)
        : [...form.days, day],
    })
  const tidy = (field: 'time' | 'onceTime') => () => {
    const tidied = tidyTime(form[field])
    if (tidied && tidied !== form[field]) onChange({ [field]: tidied })
  }
  const timeField = (field: 'time' | 'onceTime') => (
    <Field
      label={t('timed.field.time')}
      value={form[field]}
      onChangeText={(text) => onChange({ [field]: text })}
      onEndEditing={tidy(field)}
      keyboardType="numbers-and-punctuation"
      placeholder="09:00"
      error={bad(field)}
      testID={`task:${field}`}
    />
  )
  const dayChips = (
    <View style={styles.chips}>
      {WEEKDAYS.map((day) => (
        <Chip
          key={day}
          label={dayName(day, t)}
          on={form.days.includes(day)}
          onPress={() => toggleDay(day)}
          testID={`task:day:${day}`}
        />
      ))}
    </View>
  )
  const daysError = bad('days')
  const numberField = (
    field: 'monthDay' | 'intervalHours' | 'minute' | 'minutes',
    label: string,
    hint?: string,
  ) => (
    <Field
      label={label}
      value={form[field]}
      onChangeText={(text) => onChange({ [field]: text })}
      keyboardType="number-pad"
      error={bad(field)}
      hint={hint}
      testID={`task:${field}`}
    />
  )

  let fields: ReactNode = null
  switch (form.type) {
    case 'daily':
    case 'weekdays':
      fields = timeField('time')
      break
    case 'weekly':
      fields = (
        <>
          <Text style={[styles.label, { color: c.ink2 }]}>{t('timed.field.days')}</Text>
          {dayChips}
          {daysError ? <Text style={[styles.hint, { color: c.err }]}>{daysError}</Text> : null}
          {timeField('time')}
        </>
      )
      break
    case 'monthly':
      fields = (
        <>
          {numberField('monthDay', t('timed.field.monthDay'), t('timed.field.monthDay.note'))}
          {timeField('time')}
        </>
      )
      break
    case 'hourly':
      fields = (
        <>
          {numberField('intervalHours', t('timed.field.intervalHours'))}
          {numberField('minute', t('timed.field.minute'))}
          <View style={styles.switchRow}>
            <Text style={[styles.switchText, { color: c.ink }]}>{t('timed.field.allDays')}</Text>
            <Switch
              testID="task:allDays"
              value={form.hourlyAllDays}
              onValueChange={(value) => onChange({ hourlyAllDays: value })}
            />
          </View>
          {form.hourlyAllDays ? null : dayChips}
          {daysError ? <Text style={[styles.hint, { color: c.err }]}>{daysError}</Text> : null}
        </>
      )
      break
    case 'interval':
      fields = numberField('minutes', t('timed.field.minutes', { min: MIN_TASK_INTERVAL_MINUTES }))
      break
    case 'once':
      fields = (
        <>
          <Field
            label={t('timed.field.date')}
            value={form.date}
            onChangeText={(text) => onChange({ date: text })}
            keyboardType="numbers-and-punctuation"
            placeholder="2026-10-20"
            error={bad('date')}
            testID="task:date"
          />
          {timeField('onceTime')}
        </>
      )
      break
  }

  const previewText =
    preview.kind === 'next'
      ? t('timed.preview', { when: whenText(preview.at, now, t) })
      : preview.kind === 'never'
        ? t('timed.preview.never')
        : preview.kind === 'invalid'
          ? preview.message
          : null
  const zones = zoneChoices(localZone, originalZone, timezone)
  const zoneLabel = (zone: string) =>
    zone === localZone
      ? t('timed.field.timezone.local', { zone })
      : zone === originalZone
        ? t('timed.field.timezone.device', { zone })
        : zone
  return (
    <View>
      <View style={[styles.chips, styles.pad]}>
        {SCHEDULE_TYPES.map((type) => (
          <Chip
            key={type}
            label={typeName(type, t)}
            on={form.type === type}
            onPress={() => pickType(type)}
            testID={`task:type:${type}`}
          />
        ))}
      </View>
      <View style={[styles.pad, styles.fields]}>{fields}</View>
      <Row
        title={t('timed.field.timezone')}
        detail={zoneLabel(timezone)}
        testID="task:timezone"
        onPress={() => setZonePicking(true)}
      />
      {previewText ? (
        <Text
          testID="task:preview"
          style={[
            styles.preview,
            {
              color: preview.kind === 'next' ? c.ink : c.err,
              fontFamily: theme.font.mono,
            },
          ]}
        >
          {previewText}
        </Text>
      ) : null}
      <PickerSheet
        visible={zonePicking}
        title={t('timed.field.timezone')}
        value={timezone}
        search={t('composer.modelSearch')}
        options={[
          ...zones.map((zone) => ({ id: zone, title: zoneLabel(zone) })),
          { id: '', title: t('timed.field.timezone.other') },
        ]}
        onPick={(zone) => {
          setZonePicking(false)
          if (zone) onTimezone(zone)
          else setZoneTyping(true)
        }}
        onClose={() => setZonePicking(false)}
        testID="task:zones"
      />
      <Prompt
        visible={zoneTyping}
        title={t('timed.field.timezone.prompt')}
        initial={timezone}
        placeholder="Asia/Shanghai"
        submitLabel={t('form.confirm')}
        onSubmit={(zone) => {
          const name = zone.trim()
          if (zoneOk(name)) {
            setZoneError(null)
            onTimezone(name)
          } else setZoneError(t('timed.field.timezone.bad'))
        }}
        onClose={() => setZoneTyping(false)}
      />
      {zoneError ? (
        <Text style={[styles.preview, { color: c.err }]} testID="task:timezone:error">
          {zoneError}
        </Text>
      ) : null}
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
