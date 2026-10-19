// 详情设置里按类型画的控件：开关、整数和小数、一行字、多行字、单选（可以手填的带候选）、一列字（一行一项）、
// 路径、密钥（只写不读）、JSON。这一版不认识的类型只读地摆出来。
// 自定义 provider 的表单、MCP 的额外字段用的也是它。
import type { HcSettingSpec, HcValue } from '@litch/core'
import { useId } from 'react'
import { useT } from '../../app/appearance.ts'
import { HC_TYPES, type HcDraft, rawOf, secretSet } from './logic.ts'

export interface HcControlProps {
  id: string
  spec: HcSettingSpec
  /** 存着的值（没写过是 undefined，显示默认值） */
  stored: HcValue | undefined
  draft: HcDraft | undefined
  disabled: boolean
  wrong: boolean
  label?: string
  onDraft(draft: HcDraft): void
}

/** 控件里现在显示的原字：有草稿显示草稿；“恢复默认”显示默认值；否则存着的，没有就默认值 */
function shownRaw({ spec, stored, draft }: HcControlProps): boolean | string {
  if (draft?.kind === 'value') return draft.value
  if (draft?.kind === 'clear' || stored === undefined) return rawOf(spec, spec.default)
  return rawOf(spec, stored)
}

export function HcControl(props: HcControlProps) {
  const { id, spec, stored, draft, disabled, wrong, label, onDraft } = props
  const t = useT()
  const listId = useId()
  const off = disabled || spec.readOnly
  const raw = shownRaw(props)
  const set = (value: boolean | string) => onDraft({ kind: 'value', value })
  const cls = (base: string) => (wrong ? `${base} wrong` : base)
  if (!HC_TYPES.includes(spec.type)) {
    return (
      <span className="mng-unknown" id={id}>
        <code className="mono">
          {stored === undefined ? t('manage.unknown.noValue') : JSON.stringify(stored)}
        </code>
        <span className="form-note">{t('manage.unknown.note', { type: spec.type })}</span>
      </span>
    )
  }
  switch (spec.type) {
    case 'boolean':
      return (
        <button
          id={id}
          type="button"
          role="switch"
          className="switch"
          aria-checked={raw === true}
          aria-label={label}
          disabled={off}
          onClick={() => set(raw !== true)}
        >
          <i />
        </button>
      )
    case 'enum': {
      const text = String(raw)
      if (spec.allowCustom) {
        // 可以手填清单里没有的（模型名）：输入框加候选
        return (
          <>
            <input
              id={id}
              className={cls('req-input mono')}
              list={listId}
              value={text}
              placeholder={spec.placeholder ?? undefined}
              disabled={off}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set(event.target.value)}
            />
            <datalist id={listId}>
              {spec.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {t.said(option.title)}
                </option>
              ))}
            </datalist>
          </>
        )
      }
      const listed = spec.options.some((option) => option.value === text)
      return (
        <select
          id={id}
          className="req-input mng-select"
          value={text}
          disabled={off}
          onChange={(event) => set(event.target.value)}
        >
          {listed ? null : <option value={text}>{text || t('hc.value.unset')}</option>}
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {t.said(option.title)}
            </option>
          ))}
        </select>
      )
    }
    case 'secret': {
      const has = secretSet(stored) && draft?.kind !== 'clear'
      return (
        <span className="mng-secret">
          <span className={has ? 'pill ok' : 'pill mute'} data-secret-state>
            {t(
              draft?.kind === 'clear'
                ? 'manage.secret.clearing'
                : has
                  ? 'manage.secret.set'
                  : 'manage.secret.unset',
            )}
          </span>
          <input
            id={id}
            type="password"
            className={cls('req-input mono')}
            value={draft?.kind === 'value' ? String(draft.value) : ''}
            placeholder={t(has ? 'manage.secret.replace' : 'manage.secret.enter')}
            disabled={off}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => set(event.target.value)}
          />
        </span>
      )
    }
    case 'text':
    case 'stringList':
    case 'json':
      return (
        <textarea
          id={id}
          className={cls(spec.type === 'text' ? 'req-input hc-area' : 'req-input hc-area mono')}
          value={String(raw)}
          rows={spec.type === 'json' ? 5 : 3}
          placeholder={
            spec.placeholder ?? (spec.type === 'stringList' ? t('hc.list.placeholder') : undefined)
          }
          disabled={off}
          spellCheck={false}
          onChange={(event) => set(event.target.value)}
        />
      )
    default: {
      const numeric = spec.type === 'integer' || spec.type === 'number'
      return (
        <input
          id={id}
          className={cls(
            numeric
              ? 'req-input mng-num mono'
              : spec.type === 'path'
                ? 'req-input mono'
                : 'req-input',
          )}
          value={String(raw)}
          inputMode={numeric ? (spec.type === 'integer' ? 'numeric' : 'decimal') : undefined}
          placeholder={spec.placeholder ?? undefined}
          disabled={off}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set(event.target.value)}
        />
      )
    }
  }
}

/** 宽的控件（多行字、列表、JSON）放在标题下面 */
export const isWide = (spec: HcSettingSpec): boolean =>
  spec.type === 'text' ||
  spec.type === 'stringList' ||
  spec.type === 'json' ||
  !HC_TYPES.includes(spec.type)

/** 一个值写成一小段字：默认值、被盖住时实际生效的值 */
export function useHcValueText(): (
  spec: HcSettingSpec,
  value: HcValue | null | undefined,
) => string {
  const t = useT()
  return (spec, value) => {
    if (value === null || value === undefined) return t('hc.value.unset')
    if (typeof value === 'boolean') return t(value ? 'manage.value.on' : 'manage.value.off')
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') {
      const option = spec.options.find((entry) => entry.value === value)
      if (option) return t.said(option.title)
      return value === '' ? t('manage.value.empty') : value
    }
    if (Array.isArray(value))
      return value.length === 0 ? t('hc.value.none') : value.map(String).join(', ')
    if (spec.type === 'secret')
      return t(secretSet(value) ? 'manage.secret.set' : 'manage.secret.unset')
    const json = JSON.stringify(value)
    return json.length > 80 ? `${json.slice(0, 77)}…` : json
  }
}
