import type { SessionNoteView } from '@litch/core'
import { useMemo, useSyncExternalStore } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { ReportText as ReportState } from './report-text.ts'

export function ReportText({ deviceId, note }: { deviceId: string; note: SessionNoteView }) {
  const t = useT()
  const { channel } = useServices()
  const { threadId, turnId, truncated } = note
  const report = useMemo(
    () =>
      new ReportState({ turnId, truncated }, () =>
        channel.command('session.peek', {
          deviceId,
          sessionId: threadId,
          ...(turnId ? { turnId } : {}),
        }),
      ),
    [channel, deviceId, threadId, turnId, truncated],
  )
  const state = useSyncExternalStore(report.subscribe, report.snapshot)
  return (
    <span className="report-text" data-expanded={state.open}>
      <span className="report-body">{state.open ? state.text : note.excerpt}</span>
      {report.expandable ? (
        <button
          type="button"
          className="report-expand"
          disabled={state.busy}
          aria-expanded={state.open}
          onClick={() => void report.toggle()}
        >
          {t(
            state.busy
              ? 'tree.report.loading'
              : state.open
                ? 'tree.report.collapse'
                : 'tree.report.expand',
          )}
        </button>
      ) : null}
      {state.missing || state.error ? (
        <span className="sev-error" role="alert">
          {state.missing ? t('tree.report.missing') : whyNot(state.error, t)}
        </span>
      ) : null}
    </span>
  )
}
