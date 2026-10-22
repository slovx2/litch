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

/** 一行：名字和百分比、进度条、重置时间。快用完的时候换成提醒的颜色（和圆环一样的档） */
function LimitRow({ row, now }: { row: AccountLimitRow; now: number }) {
  const t = useT()
  const { usedPercent, resetsAt } = row.window
  const window = windowLabel(row.window, t)
  const label = row.name ? t('limits.named', { name: row.name, window }) : window
  const level = usedPercent >= 90 ? ' full' : usedPercent >= 70 ? ' high' : ''
  const reset = resetsIn(resetsAt, now, t)
  return (
    <div className={`limit${level}`}>
      <div className="limit-head">
        <span className="limit-name">{label}</span>
        <span className="mono">{usedPercent}%</span>
      </div>
      <span
        className="limit-bar"
        role="progressbar"
        aria-label={`${label} · ${t('limits.used', { percent: usedPercent })}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, usedPercent)}
      >
        <i style={{ width: `${Math.min(100, usedPercent)}%` }} />
      </span>
      {reset ? (
        <div
          className="limit-reset"
          title={resetsAt === null ? undefined : new Date(resetsAt).toLocaleString()}
        >
          {reset}
        </div>
      ) : null}
    </div>
  )
}

export function AccountLimits({ rows }: { rows: AccountLimitRow[] }) {
  const t = useT()
  const now = useNow()
  if (rows.length === 0) return null
  return (
    <section className="limits" aria-label={t('limits.title')}>
      <div className="limits-title">{t('limits.title')}</div>
      {rows.map((row) => (
        <LimitRow key={row.id} row={row} now={now} />
      ))}
    </section>
  )
}
