import type { ContextUsage } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { usePopover } from '../app/popover.ts'
import { showToast } from '../app/toasts.tsx'

/** 把词元数写短：980 → 980，84000 → 84k，1250000 → 1.3M */
export function shortTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) {
    const k = count / 1000
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
  }
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** 圆环的周长（半径 6） */
const RING = 2 * Math.PI * 6

/** 手动压缩上下文。已有的会话才有 */
export interface Compaction {
  /** 对面会不会。不会的话入口留着但停用，上面写着为什么 */
  able: boolean
  /** 有回合在进行，这时压不了 */
  busy: boolean
  run(): Promise<unknown>
}

function Ring({ percent }: { percent: number | null }) {
  return (
    <>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="ctx-track" cx="8" cy="8" r="6" />
        {percent === null ? null : (
          <circle
            className="ctx-fill"
            cx="8"
            cy="8"
            r="6"
            strokeDasharray={`${(percent / 100) * RING} ${RING}`}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
      {percent === null ? null : <span className="mono">{percent}%</span>}
    </>
  )
}

/**
 * 上下文占用：一个小圆环加百分比，快满的时候换成提醒的颜色。
 * 给了 compact 的话它是个按钮，点开能手动压缩上下文；这时对面没报过占用也显示（一个空的圆环）。
 * 没给 compact 时，对面没报过、或者没报窗口有多大（算不出占比）就不显示。
 */
export function ContextMeter({
  usage,
  compact,
}: {
  usage: ContextUsage | null
  compact?: Compaction | undefined
}) {
  const t = useT()
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  const percent = usage?.windowTokens
    ? Math.min(100, Math.round((usage.usedTokens / usage.windowTokens) * 100))
    : null
  if (percent === null && !compact) return null
  const level = percent === null ? '' : percent >= 90 ? ' full' : percent >= 70 ? ' high' : ''
  const label =
    percent === null || !usage?.windowTokens
      ? t('context.unknown')
      : t('composer.context', {
          percent,
          used: shortTokens(usage.usedTokens),
          window: shortTokens(usage.windowTokens),
        })
  if (!compact) {
    return (
      <span className={`ctx${level}`} role="img" title={label} aria-label={label}>
        <Ring percent={percent} />
      </span>
    )
  }
  /** 现在为什么压不了。能压就是 null */
  const blocked = !compact.able ? t('ability.unsupported') : compact.busy ? t('turn.busy') : null
  const run = () => {
    close(true)
    if (blocked) return
    compact.run().catch((error: unknown) =>
      showToast({
        id: 'compact-failed',
        tone: 'err',
        lifeMs: 8000,
        text: (say) => say('context.compactFailed', { reason: whyNot(error, say) }),
      }),
    )
  }
  return (
    <div className="pick ctx-pick" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`ctx ctx-btn${level}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Ring percent={percent} />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop ctx-pop" ref={pop} onKeyDown={onKeyDown}>
          <div className="ctx-detail">{label}</div>
          <div role="menu" aria-label={label} className="pick-list">
            {/* 压不了的时候不用 disabled：留着能看到为什么 */}
            <button
              type="button"
              role="menuitem"
              className="pick-opt ctx-compact"
              aria-disabled={blocked !== null}
              onClick={run}
            >
              <b>{t('context.compact')}</b>
              <span>{blocked ?? t('context.compactNote')}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
