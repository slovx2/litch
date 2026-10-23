import type { ContextUsage } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { usePopover } from '../app/popover.ts'
import { showToast } from '../app/toasts.tsx'
import { AccountLimits, MeterRow, useAccountLimits } from './AccountLimits.tsx'
import { shortTokens } from './limits.ts'

// 写短词元数的在 limits.ts（手机端也用），这里转一手，别处照旧从这里引
export { shortTokens }

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

/** 弹层里的账号额度：弹层开着才订阅 */
function OpenLimits({ deviceId, harness }: { deviceId: string; harness: string }) {
  return <AccountLimits rows={useAccountLimits(deviceId, harness)} />
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
 * 给了 limits（会话在哪台设备、哪个 harness 上）时，弹层里另有一段账号额度，没有额度时不出。
 */
export function ContextMeter({
  usage,
  compact,
  limits,
}: {
  usage: ContextUsage | null
  compact?: Compaction | undefined
  limits?: { deviceId: string; harness: string } | undefined
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
  /** 现在为什么压不了（按钮下面一行小字）。能压就是 null */
  const blocked = !compact.able
    ? t('context.compactUnsupported')
    : compact.busy
      ? t('context.compactBusy')
      : null
  const run = () => {
    // 压不了的时候点了不关弹层：原因就写在按钮下面
    if (blocked) return
    close(true)
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
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Ring percent={percent} />
      </button>
      {open ? (
        <div
          className="pick-pop ctx-pop"
          role="dialog"
          aria-label={label}
          ref={pop}
          onKeyDown={onKeyDown}
        >
          <MeterRow
            label={t('context.label')}
            percent={percent}
            detail={
              usage?.windowTokens
                ? `${shortTokens(usage.usedTokens)} / ${shortTokens(usage.windowTokens)}`
                : null
            }
          />
          {limits ? <OpenLimits deviceId={limits.deviceId} harness={limits.harness} /> : null}
          {/* 压不了的时候不用 disabled：还能聚焦、悬停，下面写着为什么 */}
          <button
            type="button"
            className="btn ctx-compact"
            aria-disabled={blocked !== null}
            onClick={run}
          >
            {t('context.compact')}
          </button>
          {blocked !== null ? <div className="ctx-why">{blocked}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
