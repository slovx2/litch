// 标题栏上会话标题后面的“···”：这个会话的菜单。现在只有对话区的两档视图（精简、详细，view.ts），
// 点一下就换、菜单收起。按会话记住，手机端不跟。
import { useT } from '../app/appearance.ts'
import { Check, More } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import type { MessageKey } from '../i18n/index.ts'
import { setTranscriptView, type TranscriptView, useTranscriptView } from './view.ts'

const VIEWS: { view: TranscriptView; label: MessageKey; note: MessageKey }[] = [
  { view: 'compact', label: 'transcriptView.compact', note: 'transcriptView.compact.note' },
  { view: 'verbose', label: 'transcriptView.verbose', note: 'transcriptView.verbose.note' },
]

export function SessionMenu({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const sessionKey = `${deviceId}:${sessionId}`
  const current = useTranscriptView(sessionKey)
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  return (
    <div className="tb-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        title={t('sessionMenu.title')}
        aria-label={t('sessionMenu.title')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop down" ref={pop} onKeyDown={onKeyDown}>
          <div role="menu" aria-label={t('sessionMenu.title')} className="pick-list">
            <div className="pick-title">{t('transcriptView.title')}</div>
            {VIEWS.map(({ view, label, note }) => (
              <button
                key={view}
                type="button"
                role="menuitemradio"
                aria-checked={current === view}
                className="pick-opt"
                data-view={view}
                onClick={() => {
                  setTranscriptView(sessionKey, view)
                  close(true)
                }}
              >
                <b>
                  <span className="pick-mark">{current === view ? <Check /> : null}</span>
                  {t(label)}
                </b>
                <span>{t(note)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
