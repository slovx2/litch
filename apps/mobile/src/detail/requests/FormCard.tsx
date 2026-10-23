// MCP 服务要填的一张表，或者要去网页上办的一件事。栏目只有 MCP 规定的几种简单的（字、数、是否、单选、多选），
// 认不出的整张表核心就不接。提交之前照对面给的必填和范围查一遍、指出是哪一栏：对面会拒掉不合的值，而且不告诉用户
// （和桌面端 packages/ui/src/composer/FormCard.tsx 同一套检查）。网页地址交给系统浏览器打开。
import type { FormField, FormRequest } from '@litch/core'
import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { type Key, useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { Card, CardButton, type CardProps, useRespond, Well, Why } from './Card'

/** 一栏里填着的东西：字和数都先当字存着，提交时再换 */
type Filled = string | boolean | string[]

const initialOf = (field: FormField): Filled => {
  if (field.kind === 'boolean') return field.initial === true
  if (field.kind === 'choices') return Array.isArray(field.initial) ? field.initial : []
  return field.initial === null || typeof field.initial === 'object' ? '' : String(field.initial)
}

function Control({
  field,
  value,
  wrong,
  onChange,
}: {
  field: FormField
  value: Filled
  wrong: boolean
  onChange(value: Filled): void
}) {
  const theme = useTheme()
  const { c } = theme
  if (field.kind === 'boolean') {
    return (
      <View style={styles.check}>
        <Switch
          value={value === true}
          onValueChange={onChange}
          testID={`form:${field.id}`}
          trackColor={{ true: c.accent, false: c.line2 }}
        />
        <Text style={[styles.checkText, { color: c.ink }]}>{field.label}</Text>
      </View>
    )
  }
  if (field.kind === 'choice' || field.kind === 'choices') {
    const many = field.kind === 'choices'
    const picked: string[] = Array.isArray(value)
      ? value
      : typeof value === 'string' && value
        ? [value]
        : []
    const toggle = (option: string) => {
      if (!many) return onChange(picked[0] === option && !field.required ? '' : option)
      onChange(
        picked.includes(option) ? picked.filter((entry) => entry !== option) : [...picked, option],
      )
    }
    return (
      <View style={styles.picks}>
        {field.options.map((option) => {
          const on = picked.includes(option.value)
          return (
            <Pressable
              key={option.value}
              accessibilityRole={many ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on }}
              testID={`form:${field.id}:${option.value}`}
              onPress={() => toggle(option.value)}
              style={[
                styles.pick,
                {
                  borderColor: wrong ? c.err : on ? c.line3 : c.line2,
                  backgroundColor: on ? c.selBg : c.panel,
                  borderRadius: theme.radius.m,
                  minHeight: theme.hit - 8,
                },
              ]}
            >
              <Text style={{ color: on ? c.selFg : c.ink, fontSize: 14 }}>{option.label}</Text>
            </Pressable>
          )
        })}
      </View>
    )
  }
  const numeric = field.kind === 'number' || field.kind === 'integer'
  return (
    <TextInput
      value={typeof value === 'string' ? value : ''}
      onChangeText={onChange}
      testID={`form:${field.id}`}
      keyboardType={
        numeric
          ? field.kind === 'integer'
            ? 'number-pad'
            : 'decimal-pad'
          : field.format === 'email'
            ? 'email-address'
            : field.format === 'uri'
              ? 'url'
              : 'default'
      }
      placeholder={
        field.format === 'date'
          ? '2026-01-31'
          : field.format === 'date-time'
            ? '2026-01-31T09:00:00Z'
            : undefined
      }
      placeholderTextColor={c.ink3}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        styles.input,
        {
          color: c.ink,
          borderColor: wrong ? c.err : c.line2,
          backgroundColor: c.panel,
          borderRadius: theme.radius.m,
          minHeight: theme.hit,
        },
      ]}
    />
  )
}

export function FormCard(props: CardProps<FormRequest>) {
  const { request, waiting } = props
  const { fields, link } = request
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const { busy, error, setError, respond } = useRespond(props)
  const [values, setValues] = useState<Record<string, Filled>>(() =>
    Object.fromEntries(fields.map((field) => [field.id, initialOf(field)])),
  )
  /** 没填对的那一栏和原因 */
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null)

  const submit = () => {
    const out: Record<string, unknown> = {}
    const fail = (field: FormField, key: Key, limit?: number) =>
      setProblem({ id: field.id, text: t(key, { name: field.label, limit: limit ?? '' }) })
    for (const field of fields) {
      const raw = values[field.id]
      if (field.kind === 'boolean') {
        out[field.id] = raw === true
        continue
      }
      if (field.kind === 'choices') {
        const list = Array.isArray(raw) ? raw : []
        if (list.length === 0 && field.required) return fail(field, 'form.missing')
        if (list.length > 0) out[field.id] = list
        continue
      }
      const text = typeof raw === 'string' ? raw : ''
      if (!text.trim()) {
        if (field.required) return fail(field, 'form.missing')
        continue
      }
      if (field.kind === 'number' || field.kind === 'integer') {
        const number = Number(text)
        if (!Number.isFinite(number)) return fail(field, 'form.number')
        if (field.kind === 'integer' && !Number.isInteger(number))
          return fail(field, 'form.integer')
        const { min, max } = field.limits
        if (min !== null && number < min) return fail(field, 'form.min', min)
        if (max !== null && number > max) return fail(field, 'form.max', max)
        out[field.id] = number
      } else {
        const { minLength, maxLength } = field.limits
        // 按字数算，和对面的算法一样
        const length = [...text].length
        if (minLength !== null && length < minLength)
          return fail(field, 'form.minLength', minLength)
        if (maxLength !== null && length > maxLength)
          return fail(field, 'form.maxLength', maxLength)
        out[field.id] = text
      }
    }
    setProblem(null)
    respond({ optionId: 'accept', values: out })
  }

  /** 对面给这一栏定的范围，写成一句提示；没定就是空的 */
  const rangeOf = ({ limits }: FormField): string => {
    const numeric = limits.min !== null || limits.max !== null
    const least = numeric ? limits.min : limits.minLength
    const most = numeric ? limits.max : limits.maxLength
    if (least !== null && most !== null)
      return t(numeric ? 'form.range' : 'form.length', { min: least, max: most })
    if (least !== null) return t(numeric ? 'form.range.min' : 'form.length.min', { limit: least })
    return most !== null ? t(numeric ? 'form.range.max' : 'form.length.max', { limit: most }) : ''
  }
  const open = () => {
    if (link?.openable) Linking.openURL(link.url).catch((reason: Error) => setError(reason.message))
  }

  return (
    <Card
      testID="request:form"
      title={t(link ? 'request.link' : 'request.form', { server: request.server })}
      waiting={waiting}
      error={error}
      actions={
        <>
          {link?.openable ? (
            <CardButton testID="form:open" label={t('form.open')} onPress={open} />
          ) : null}
          {link ? (
            <CardButton
              kind="primary"
              testID="form:done"
              label={t('form.done')}
              disabled={busy || !link.openable}
              onPress={() => respond({ optionId: 'accept' })}
            />
          ) : (
            <CardButton
              kind="primary"
              testID="form:submit"
              label={t(fields.length > 0 ? 'request.submit' : 'form.confirm')}
              disabled={busy}
              onPress={submit}
            />
          )}
          <CardButton
            kind="ghost"
            testID="form:decline"
            label={t('request.option.decline')}
            disabled={busy}
            onPress={() => respond({ optionId: 'decline' })}
          />
        </>
      }
    >
      {request.message ? <Why>{request.message}</Why> : null}
      {link ? <Well>{link.url}</Well> : null}
      {link && !link.openable ? <Why>{t('form.unsafeLink')}</Why> : null}
      {fields.map((field) => {
        const range = rangeOf(field)
        return (
          <View key={field.id} style={styles.field}>
            {field.kind === 'boolean' ? null : (
              <Text style={[styles.label, { color: c.ink2 }]}>
                {field.label}
                {field.required ? <Text style={{ color: c.err }}> *</Text> : null}
              </Text>
            )}
            <Control
              field={field}
              value={values[field.id] ?? ''}
              wrong={problem?.id === field.id}
              onChange={(value) => {
                setValues((current) => ({ ...current, [field.id]: value }))
                if (problem?.id === field.id) setProblem(null)
              }}
            />
            {field.note ? <Text style={[styles.note, { color: c.ink3 }]}>{field.note}</Text> : null}
            {range ? <Text style={[styles.note, { color: c.ink3 }]}>{range}</Text> : null}
            {problem?.id === field.id ? (
              <Text testID="form:problem" style={[styles.note, { color: c.err }]}>
                {problem.text}
              </Text>
            ) : null}
          </View>
        )
      })}
    </Card>
  )
}

const styles = StyleSheet.create({
  field: { gap: 4 },
  label: { fontSize: 13, fontWeight: '500' },
  input: { borderWidth: 1, paddingHorizontal: 10, fontSize: 15 },
  note: { fontSize: 12 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkText: { fontSize: 15, flex: 1 },
  picks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pick: { borderWidth: 1, paddingHorizontal: 10, justifyContent: 'center' },
})
