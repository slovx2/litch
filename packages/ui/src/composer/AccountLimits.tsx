// 用量环弹层里的“账号额度”：订阅登录的账号（Claude Code 的 Anthropic 订阅、Codex 的 ChatGPT 登录）才有。
// 弹层开着才订阅（accountLimits 主题），核心那时才去读。没有额度时什么都不画，弹层和原来一样。
import type { AccountLimitRow, AccountLimitsOp } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { useServices } from '../app/services.tsx'
import { resetsIn, windowLabel } from './limits.ts'

/** 订阅一个 harness 的账号额度。harness 不知道时不订，回空的 */
export function useAccountLimits(deviceId: string, harness: string | undefined): AccountLimitRow[] {
  const { channel } = useServices()
  const [rows, setRows] = useState<AccountLimitRow[]>([])
  useEffect(() => {
    setRows([])
    if (!harness) return
    return channel.subscribe(
      { kind: 'accountLimits', deviceId, harness },
      {
        snapshot: (data) => setRows(data.rows),
        delta: (ops: AccountLimitsOp[]) => {
          const last = ops.at(-1)
          if (last) setRows(last.view.rows)
        },
        // 订不上就当没有额度
        error: () => setRows([]),
      },
    )
  }, [channel, deviceId, harness])
  return rows
}

/**
 * 弹层里的一行用量：名字靠左，补充的那句（词元数、什么时候重置）和百分比靠右，下面一条细进度条。
 * 上下文和账号额度都用它。快用完的时候换成提醒的颜色（和圆环同档）。percent 是 null 时只画空的条
 */
export function MeterRow({
  label,
  percent,
  detail,
  title,
}: {
  label: string
  percent: number | null
  detail: string | null
  /** 补充那句悬停时的说明（重置的具体时刻） */
  title?: string | undefined
}) {
  const t = useT()
  const level = percent === null ? '' : percent >= 90 ? ' full' : percent >= 70 ? ' high' : ''
  const width = percent === null ? 0 : Math.min(100, percent)
  return (
    <div className={`meter${level}`}>
      <div className="meter-head">
        <span className="meter-name">{label}</span>
        {detail ? (
          <span className="meter-detail" title={title}>
            {detail}
          </span>
        ) : null}
        <span className="meter-pct mono">{percent === null ? '—' : `${percent}%`}</span>
      </div>
      <span
        className="meter-bar"
        role="progressbar"
        aria-label={percent === null ? label : `${label} · ${t('limits.used', { percent })}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
      >
        <i className="meter-fill" style={{ width: `${width}%` }} />
      </span>
    </div>
  )
}

/** 账号额度的几行。没有额度时什么都不画 */
export function AccountLimits({ rows }: { rows: AccountLimitRow[] }) {
  const t = useT()
  const now = useNow()
  return rows.map((row) => {
    const window = windowLabel(row.window, t)
    const { resetsAt } = row.window
    return (
      <MeterRow
        key={row.id}
        label={row.name ? t('limits.named', { name: row.name, window }) : window}
        percent={row.window.usedPercent}
        detail={resetsIn(resetsAt, now, t)}
        title={resetsAt === null ? undefined : new Date(resetsAt).toLocaleString()}
      />
    )
  })
}
