import type { FormField, FormRequest } from '@litch/core'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import type { MessageKey } from '../i18n/index.ts'
import { clickLink } from '../side/browser/links.ts'
import { busyWriting } from './focus.ts'
import { type CardProps, Foot, ownsKey, useRespond } from './respond.tsx'

/** 一栏里填着的东西：字和数都先当字存着，提交时再换 */
type Filled = string | boolean | string[]

const initialOf = (field: FormField): Filled => {
  if (field.kind === 'boolean') return field.initial === true
  if (field.kind === 'choices') return Array.isArray(field.initial) ? field.initial : []
  return field.initial === null || typeof field.initial === 'object' ? '' : String(field.initial)
}

const INPUT_TYPE: Record<NonNullable<FormField['format']>, string> = {
  email: 'email',
  uri: 'url',
  date: 'date',
  // 带时区的时刻没有合适的原生控件，照着例子手写
  'date-time': 'text',
}

interface FieldProps {
  field: FormField
  value: Filled
  onChange(value: Filled): void
  /** 这一栏没填对 */
  wrong: boolean
  inputId: string
}

function Control({ field, value, onChange, wrong, inputId }: FieldProps) {
  if (field.kind === 'boolean') {
    return (
      <label className="form-check">
        <input
          id={inputId}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{field.label}</span>
      </label>
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
    const classes = wrong ? 'pickset wrong' : 'pickset'
    const buttons = field.options.map((option) =>
      many ? (
        // biome-ignore lint/a11y/useSemanticElements: 原生的多选框画不成这个样子
        <button
          key={option.value}
          type="button"
          role="checkbox"
          className="pickset-opt"
          aria-checked={picked.includes(option.value)}
          onClick={() => toggle(option.value)}
        >
          {option.label}
        </button>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: 原生的单选框画不成这个样子
        <button
          key={option.value}
          type="button"
          role="radio"
          className="pickset-opt"
          aria-checked={picked.includes(option.value)}
          onClick={() => toggle(option.value)}
        >
          {option.label}
        </button>
      ),
    )
    return many ? (
      // biome-ignore lint/a11y/useSemanticElements: 这一组没有自己的边框和标题，不用 fieldset
      <div id={inputId} className={classes} role="group" aria-label={field.label}>
        {buttons}
      </div>
    ) : (
      <div id={inputId} className={classes} role="radiogroup" aria-label={field.label}>
        {buttons}
      </div>
    )
  }
  const numeric = field.kind === 'number' || field.kind === 'integer'
  return (
    <input
      id={inputId}
      className={wrong ? 'req-input wrong' : 'req-input'}
      type={numeric || !field.format ? 'text' : INPUT_TYPE[field.format]}
      inputMode={numeric ? (field.kind === 'integer' ? 'numeric' : 'decimal') : undefined}
      placeholder={field.format === 'date-time' ? '2026-01-31T09:00:00Z' : undefined}
      value={typeof value === 'string' ? value : ''}
      aria-invalid={wrong}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** MCP 服务要填的一张表，或者要去网页上办的一件事 */
export function FormCard(props: CardProps<FormRequest>) {
  const { request, waiting } = props
  const { fields, link } = request
  const t = useT()
  const { busy, error, respond } = useRespond(props)
  const card = useRef<HTMLElement>(null)
  const [values, setValues] = useState<Record<string, Filled>>(() =>
    Object.fromEntries(fields.map((field) => [field.id, initialOf(field)])),
  )
  /** 没填对的那一栏和原因 */
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null)
  const inputId = (field: FormField) => `form-${request.id}-${field.id}`

  // 卡片一出现，焦点落在第一个能打字的地方；没有就落在卡片上。人正写着东西的不打断
  useEffect(() => {
    if (busyWriting(document.activeElement)) return
    const first = card.current?.querySelector<HTMLElement>('input.req-input')
    ;(first ?? card.current)?.focus({ preventScroll: true })
  }, [])

  const submit = () => {
    const out: Record<string, unknown> = {}
    const fail = (field: FormField, key: MessageKey, limit?: number) => {
      setProblem({ id: field.id, text: t(key, { name: field.label, limit: limit ?? '' }) })
      document.getElementById(inputId(field))?.focus()
    }
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
        // 对面定了范围的：出界的它会拒掉，而且不给回音，所以在这里拦下并说清楚
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
  const decline = () => respond({ optionId: 'decline' })

  // 回车提交（去网页上办的事不设回车，免得还没去办就说办好了），Esc 拒绝
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!ownsKey(event, card.current)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        decline()
      } else if (event.key === 'Enter' && !link && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault()
        submit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // 和回答里的链接一样：默认在内置浏览器里开，中键、Cmd/Ctrl 点交给系统的浏览器（side/browser/links.ts）
  const openLink = (event: MouseEvent) => {
    if (!link || (event.button !== 0 && event.button !== 1)) return
    if (clickLink(link.url, event)) event.preventDefault()
  }
  /** 对面给这一栏定的范围，写成一句提示；没定就是空的 */
  const rangeOf = ({ limits }: FormField): string => {
    const [least, most, between, atLeast, atMost] =
      limits.min !== null || limits.max !== null
        ? ([limits.min, limits.max, 'form.range', 'form.range.min', 'form.range.max'] as const)
        : ([
            limits.minLength,
            limits.maxLength,
            'form.length',
            'form.length.min',
            'form.length.max',
          ] as const)
    if (least !== null && most !== null) return t(between, { min: least, max: most })
    if (least !== null) return t(atLeast, { limit: least })
    return most !== null ? t(atMost, { limit: most }) : ''
  }
  const title = t(link ? 'request.link' : 'request.form', { server: request.server })
  return (
    <section className="req" ref={card} tabIndex={-1} aria-label={title}>
      <div className="req-head">
        <i className="st wait" />
        <span>{title}</span>
      </div>
      <div className="req-body req-form">
        {request.message ? <div className="req-why">{request.message}</div> : null}
        {link ? (
          <div className="well">
            <pre>{link.url}</pre>
          </div>
        ) : null}
        {link && !link.openable ? <div className="req-why">{t('form.unsafeLink')}</div> : null}
        {fields.map((field) => (
          <div key={field.id} className="form-field">
            {field.kind === 'boolean' ? null : (
              <label className="form-label" htmlFor={inputId(field)}>
                {field.label}
                {field.required ? <i title={t('form.required')}>*</i> : null}
              </label>
            )}
            <Control
              field={field}
              value={values[field.id] ?? ''}
              wrong={problem?.id === field.id}
              inputId={inputId(field)}
              onChange={(value) => {
                setValues((current) => ({ ...current, [field.id]: value }))
                if (problem?.id === field.id) setProblem(null)
              }}
            />
            {field.note ? <span className="form-note">{field.note}</span> : null}
            {rangeOf(field) ? (
              <span className="form-note" data-range>
                {rangeOf(field)}
              </span>
            ) : null}
            {problem?.id === field.id ? (
              <span className="form-note err">{problem.text}</span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="req-actions">
        {link?.openable ? (
          <a
            className="btn"
            href={link.url}
            target="_blank"
            rel="noreferrer"
            onClick={openLink}
            onAuxClick={openLink}
          >
            {t('form.open')}
          </a>
        ) : null}
        {link ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy || !link.openable}
            onClick={() => respond({ optionId: 'accept' })}
          >
            {t('form.done')}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>
            {t(fields.length > 0 ? 'request.submit' : 'form.confirm')}
            <span className="kbd">↵</span>
          </button>
        )}
        <button type="button" className="btn ghost" disabled={busy} onClick={decline}>
          {t('request.option.decline')}
          <span className="kbd">Esc</span>
        </button>
      </div>
      <Foot waiting={waiting} error={error} />
    </section>
  )
}
