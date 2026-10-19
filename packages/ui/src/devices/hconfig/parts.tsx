// 详情设置几块共用的小件：一块数据没读到时的那一句、对话框外壳、在系统浏览器里打开地址、
// 登录要填的表单、一次登录走到哪一步（provider 和 MCP 的 OAuth 共用）。
import type { ChannelErrorShape, HcAttempt, HcAuthField } from '@litch/core'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'

/** 一块数据还没读到、读不成时说一句（读不成给“重试”） */
export function SlotState({
  slot,
  onRetry,
}: {
  slot: { data: unknown; loading: boolean; error: ChannelErrorShape | null }
  onRetry(): void
}) {
  const t = useT()
  if (slot.error && !slot.data) {
    return (
      <div className="mng-state err" data-hc-slot="error" role="alert">
        <span className="grow">{t('hc.unreadable', { reason: whyNot(slot.error, t) })}</span>
        <button type="button" className="btn" data-act="hc-retry" onClick={onRetry}>
          {t('sidebar.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className="mng-state" data-hc-slot="loading">
      {t('manage.loading')}
    </div>
  )
}

/** 在系统浏览器里打开（桌面外壳）；普通浏览器里的开发预览开新标签 */
export function openOutside(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const shell = window.litchShell
  if (shell) shell.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

/** 做一件事，没成弹一句。成了返回结果，没成返回 undefined */
export function useRun(): <T>(id: string, work: () => Promise<T>) => Promise<T | undefined> {
  return async (id, work) => {
    try {
      return await work()
    } catch (error) {
      showToast({
        id,
        tone: 'err',
        text: (say) => say('hc.failed', { reason: whyNot(error, say) }),
        lifeMs: 9000,
      })
      return undefined
    }
  }
}

interface DialogProps {
  title: string
  /** data-hc-dialog 的值，验收脚本靠它找 */
  kind: string
  wide?: boolean
  busy: boolean
  failure: string | null
  /** 确定按钮上的字；ready 为假时按不了 */
  yes: string
  ready: boolean
  onSubmit(): void
  onClose(): void
  children: ReactNode
}

/** 详情设置里的对话框：一个表单，底下取消和确定 */
export function HcDialog({
  title,
  kind,
  wide,
  busy,
  failure,
  yes,
  ready,
  onSubmit,
  onClose,
  children,
}: DialogProps) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready && !busy) onSubmit()
  }
  return (
    <dialog
      ref={dialog}
      className={wide ? 'modal hc-dialog wide' : 'modal hc-dialog'}
      aria-label={title}
      data-hc-dialog={kind}
      onClose={onClose}
      onKeyDown={(event) => {
        // Esc 只关这个对话框，别让外面的 Esc 处理也跟着动
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        <div className="modal-body hc-dialog-body">
          {children}
          {failure ? (
            <div className="modal-note err" role="alert" data-hc-failure>
              {failure}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button type="button" className="btn" data-act="hc-dialog-cancel" onClick={onClose}>
            {t('workspace.cancel')}
          </button>
          <button
            type="submit"
            className="btn primary"
            data-act="hc-dialog-yes"
            disabled={!ready || busy}
          >
            {busy ? t('manage.saving') : yes}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** 登录要填的几栏（API key、粘贴回来的授权码、表单）。值是 id → 字 */
export function AuthFields({
  idPrefix,
  fields,
  values,
  disabled,
  onChange,
}: {
  idPrefix: string
  fields: readonly HcAuthField[]
  values: Record<string, string>
  disabled: boolean
  onChange(values: Record<string, string>): void
}) {
  const t = useT()
  return (
    <>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.id}`
        const value = values[field.id] ?? ''
        const set = (next: string) => onChange({ ...values, [field.id]: next })
        return (
          <div className="form-field" key={field.id} data-hc-field={field.id}>
            <label className="form-label" htmlFor={id}>
              {t.said(field.title)}
              {field.optional ? <span className="dim"> {t('hc.optional')}</span> : null}
            </label>
            {field.options.length > 0 ? (
              <select
                id={id}
                className="req-input mng-select"
                value={value}
                disabled={disabled}
                onChange={(event) => set(event.target.value)}
              >
                {value === '' ? <option value="">{t('hc.value.unset')}</option> : null}
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t.said(option.title)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                className="req-input mono"
                type={field.secret ? 'password' : 'text'}
                value={value}
                placeholder={field.placeholder ?? undefined}
                disabled={disabled}
                autoComplete={field.secret ? 'new-password' : 'off'}
                spellCheck={false}
                onChange={(event) => set(event.target.value)}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

/** 必填的都填了 */
export const filled = (fields: readonly HcAuthField[], values: Record<string, string>): boolean =>
  fields.every((field) => field.optional || (values[field.id] ?? '').trim() !== '')

/** 只交填了的 */
export const inputsOf = (
  fields: readonly HcAuthField[],
  values: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    fields.flatMap((field) =>
      (values[field.id] ?? '') !== '' ? [[field.id, values[field.id] ?? '']] : [],
    ),
  )

/** 一次登录走到哪一步：打开授权页（带回调转发的状态，或粘贴授权码）、设备码、要填的表单、成了、没成 */
export function AttemptView({
  deviceId,
  harness,
  attempt,
  title,
}: {
  deviceId: string
  harness: string
  attempt: HcAttempt
  /** 登的是谁（provider 或 MCP 服务的名字） */
  title: string
}) {
  const t = useT()
  const { channel } = useServices()
  const [values, setValues] = useState<Record<string, string>>({})
  const { step, forward, busy } = attempt
  const base = { deviceId, harness, attemptId: attempt.attemptId }
  const run = useRun()
  const send = (fields: readonly HcAuthField[]) => {
    if (!filled(fields, values)) return
    void run(`hc-auth:${attempt.attemptId}`, () =>
      channel.command('harnessConfig.auth.continue', { ...base, inputs: inputsOf(fields, values) }),
    ).then(() => setValues({}))
  }
  const cancel = () =>
    void run(`hc-auth:${attempt.attemptId}`, () =>
      channel.command('harnessConfig.auth.cancel', base),
    )
  const dismiss = () =>
    void run(`hc-auth:${attempt.attemptId}`, () =>
      channel.command('harnessConfig.auth.dismiss', base),
    )
  const finished = step.kind === 'done' || step.kind === 'failed'
  const form = (fields: readonly HcAuthField[], yes: string) =>
    fields.length > 0 ? (
      <form
        className="hc-auth-form"
        onSubmit={(event) => {
          event.preventDefault()
          send(fields)
        }}
      >
        <AuthFields
          idPrefix={`hc-auth-${attempt.attemptId}`}
          fields={fields}
          values={values}
          disabled={busy}
          onChange={setValues}
        />
        <div className="hc-auth-acts">
          <button
            type="submit"
            className="btn primary"
            data-act="hc-auth-send"
            disabled={busy || !filled(fields, values)}
          >
            {busy ? t('hc.auth.sending') : yes}
          </button>
        </div>
      </form>
    ) : null

  let body: ReactNode = null
  switch (step.kind) {
    case 'openUrl':
      body = (
        <>
          <span className="form-note">
            {step.message ? t.said(step.message) : t('hc.auth.openUrl')}
          </span>
          <div className="hc-auth-url">
            <code className="mono ell" title={step.url}>
              {step.url}
            </code>
            <button
              type="button"
              className="btn primary"
              data-act="hc-auth-open"
              onClick={() => openOutside(step.url)}
            >
              {t('hc.auth.open')}
            </button>
          </div>
          {forward ? (
            <span
              className={
                forward.state === 'failed' || forward.state === 'unavailable'
                  ? 'form-note err'
                  : 'form-note'
              }
              data-hc-forward={forward.state}
            >
              {t(`hc.forward.${forward.state}`, {
                port: forward.port,
                reason: forward.message ?? '',
              })}
            </span>
          ) : null}
          {form(step.prompt, t('hc.auth.paste'))}
        </>
      )
      break
    case 'deviceCode':
      body = (
        <>
          <span className="form-note">
            {step.message ? t.said(step.message) : t('hc.auth.deviceCode')}
          </span>
          <div className="hc-auth-code">
            <code className="mono" data-hc-user-code>
              {step.userCode}
            </code>
            <button
              type="button"
              className="btn"
              data-act="hc-auth-copy"
              onClick={() => void navigator.clipboard?.writeText(step.userCode)}
            >
              {t('hc.auth.copy')}
            </button>
            <button
              type="button"
              className="btn primary"
              data-act="hc-auth-open"
              onClick={() => openOutside(step.url)}
            >
              {t('hc.auth.open')}
            </button>
          </div>
          <code className="mono ell form-note">{step.url}</code>
        </>
      )
      break
    case 'prompt':
      body = (
        <>
          {step.message ? <span className="form-note">{t.said(step.message)}</span> : null}
          {form(step.fields, t('hc.auth.submit'))}
        </>
      )
      break
    case 'done':
      body = (
        <span className="hc-auth-result ok">
          {step.auth.label ? t('hc.auth.doneAs', { label: step.auth.label }) : t('hc.auth.done')}
        </span>
      )
      break
    case 'failed':
      body = (
        <span className="hc-auth-result err" role="alert">
          {t('hc.auth.failed', { reason: t.said(step.message) })}
        </span>
      )
      break
  }
  return (
    <div
      className="hc-attempt"
      data-hc-attempt={attempt.attemptId}
      data-step={step.kind}
      data-busy={busy}
    >
      <div className="hc-attempt-head">
        <b className="grow">{t('hc.auth.title', { name: title })}</b>
        {finished ? (
          <button type="button" className="mini" data-act="hc-auth-dismiss" onClick={dismiss}>
            {t('hc.auth.dismiss')}
          </button>
        ) : (
          <button type="button" className="mini" data-act="hc-auth-cancel" onClick={cancel}>
            {t('workspace.cancel')}
          </button>
        )}
      </div>
      {body}
    </div>
  )
}
