// 一条子会话的回报（回报事件条、派出卡共用）：上面一行是调用方给的头（标题、状态，或“回报”两个字），
// 截断了的在这一行末尾带一个小图标按钮读全文；下面是正文，占满卡片宽度、按 Markdown 画。
// 头和正文上下排，不左右分栏：左右分栏时标题那一栏下面整块是空的
import type { SessionNoteView } from '@litch/core'
import { type ReactNode, useMemo, useSyncExternalStore } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { CardMarkdown } from '../transcript/CardMarkdown.tsx'
import { ReportText as ReportState } from './report-text.ts'

export function ReportText({
  deviceId,
  note,
  head,
}: {
  deviceId: string
  note: SessionNoteView
  head: ReactNode
}) {
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
  const label = t(
    state.busy ? 'tree.report.loading' : state.open ? 'tree.report.collapse' : 'tree.report.expand',
  )
  const text = state.open ? state.text : note.excerpt
  return (
    <div className="report-text" data-expanded={state.open}>
      <div className="report-head">
        {head}
        {report.expandable ? (
          <button
            type="button"
            className="report-expand"
            disabled={state.busy}
            aria-expanded={state.open}
            aria-label={label}
            title={label}
            onClick={() => void report.toggle()}
          >
            <Icon name={state.open ? 'compact' : 'expand'} small />
          </button>
        ) : null}
      </div>
      {text ? (
        <div className="report-body">
          <CardMarkdown text={text} />
        </div>
      ) : null}
      {state.missing || state.error ? (
        <span className="sev-error" role="alert">
          {state.missing ? t('tree.report.missing') : whyNot(state.error, t)}
        </span>
      ) : null}
    </div>
  )
}
