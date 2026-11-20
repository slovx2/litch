import { type ExternalDiagnostic, type ExternalSnapshot, githubExternalUrl } from '@litch/core'
import { type FormEvent, type ReactNode, useEffect, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Close, Notice } from '../app/icons.tsx'
import { clickLink } from '../side/browser/links.ts'
import { externalTime } from './external-view.ts'

export function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  const href = githubExternalUrl(url)
  if (!href) return <span>{children}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (clickLink(href, event)) event.preventDefault()
      }}
    >
      {children}
    </a>
  )
}

export function ExternalStatus({ view }: { view: ExternalSnapshot<unknown> | undefined }) {
  const t = useT()
  if (!view) return <p className="external-note">{t('external.loading')}</p>
  if (!view.online)
    return (
      <p className="external-note" role="status">
        {view.fetchedAt === null
          ? t('external.offline')
          : t('external.stale', {
              time: externalTime(view.fetchedAt / 1000, t.lang),
            })}
      </p>
    )
  if (!view.available) return <p className="external-note">{t('external.unsupported')}</p>
  if (view.error)
    return (
      <p className="err" role="alert">
        {whyNot(view.error, t)}
      </p>
    )
  return view.fetchedAt === null ? <p className="external-note">{t('external.loading')}</p> : null
}

export function ExternalDiagnostics({ items }: { items: ExternalDiagnostic[] }) {
  const t = useT()
  if (!items.length) return null
  const unique = new Map(
    items.map((item) => [
      JSON.stringify([item.check, item.code, item.state, item.checkedAt]),
      item,
    ]),
  )
  return (
    <ul className="external-diagnostics">
      {[...unique].map(([key, item]) => (
        <li key={key}>
          <span>
            {item.check === 'executionIsolation' ? t('external.isolationInfo') : item.check}
          </span>{' '}
          <span className="dim">
            {t(`external.check.${item.state}`)} · {item.code}
            {item.checkedAt !== undefined ? ` · ${externalTime(item.checkedAt, t.lang)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ExternalDialog({
  label,
  children,
  close,
}: {
  label: string
  children: ReactNode
  close(): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const t = useT()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="external-dialog"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <header className="external-row">
        <h2 className="grow">{label}</h2>
        <button type="button" className="ibtn" aria-label={t('external.cancel')} onClick={close}>
          <Close />
        </button>
      </header>
      {children}
    </dialog>
  )
}

export function ExternalTokenPrompt({
  target,
  onSend,
  onClose,
}: {
  target: string
  onSend(token: string): void
  onClose(): void
}) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const field = ref.current
    if (field?.value) {
      const value = field.value
      field.value = ''
      onSend(value)
    }
  }
  return (
    <ExternalDialog label={target} close={onClose}>
      <form onSubmit={submit} className="external-stack">
        <label className="external-field">
          {t('external.setupToken')}
          <input
            ref={ref}
            name="github-pat"
            type="password"
            autoComplete="off"
            maxLength={4096}
            required
          />
        </label>
        <footer className="external-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('external.cancel')}
          </button>
          <button type="submit" className="btn">
            {t('external.yes')}
          </button>
        </footer>
      </form>
    </ExternalDialog>
  )
}

export function ExternalWarning({ children }: { children: ReactNode }) {
  return (
    <p className="external-warning" role="alert">
      <Notice />
      {children}
    </p>
  )
}
