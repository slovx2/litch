// 审批卡上的“限时允许”：点开一行选时长（几个常用值或自己填），确认后授予这个会话这一类（MCP 再按服务）的限时授权。
// 授予之后不用再答这张卡片：原生审批由设备一并代答，客户端工具由核心按名单放行，卡片自己消失。
import {
  type RequestView,
  TIMED_APPROVAL_MAX_HOURS,
  TIMED_APPROVAL_MIN_HOURS,
  TIMED_APPROVAL_PRESETS,
  timedTargetOf,
  validTimedApprovalHours,
} from '@litch/core'
import { useState } from 'react'
import { useAppearance, useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { reasonOf } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { timedWhat, untilText, useTimedApprovals } from './timed.ts'

const DEFAULT_HOURS = 4

interface Props {
  deviceId: string
  sessionId: string
  request: RequestView
  /** 卡片正在答复别的选项 */
  disabled: boolean
}

/** 卡片按钮行里的入口；这张卡片不能限时放行（或设备不支持）时什么都不画 */
export function useTimedAllow({ deviceId, sessionId, request, disabled }: Props) {
  const t = useT()
  const { lang } = useAppearance()
  const now = useNow()
  const { channel } = useServices()
  const view = useTimedApprovals(deviceId)
  const target = timedTargetOf(request)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(String(DEFAULT_HOURS))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const what = target ? timedWhat(t, target) : null
  if (!target || !what || !view?.available) return { button: null, panel: null }

  const hours = Number(text)
  const valid = text.trim() !== '' && validTimedApprovalHours(hours)
  const grant = () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    channel
      .command('timedApproval.grant', {
        deviceId,
        threadId: sessionId,
        category: target.category,
        ...(target.scope ? { scope: target.scope } : {}),
        hours,
      })
      .catch((failure: unknown) => {
        setBusy(false)
        setError(t('timed.failed', { reason: reasonOf(failure, t) }))
      })
  }

  const button = (
    <button
      type="button"
      className="btn ghost timed-open"
      disabled={disabled || busy}
      aria-expanded={open}
      title={t('timed.openTitle', { what })}
      onClick={() => setOpen(!open)}
    >
      <Icon name="clock" small />
      {t('timed.open')}
    </button>
  )
  const panel = open ? (
    <fieldset className="req-timed" aria-label={t('timed.open')}>
      <div className="timed-row">
        {TIMED_APPROVAL_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={hours === preset ? 'btn timed-preset on' : 'btn timed-preset'}
            aria-pressed={hours === preset}
            disabled={busy}
            onClick={() => setText(String(preset))}
          >
            {t('timed.preset', { hours: preset })}
          </button>
        ))}
        <label className="timed-hours">
          <input
            className="req-input"
            type="number"
            inputMode="decimal"
            min={TIMED_APPROVAL_MIN_HOURS}
            max={TIMED_APPROVAL_MAX_HOURS}
            step={0.5}
            value={text}
            disabled={busy}
            aria-label={t('timed.hoursLabel')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                grant()
              }
            }}
          />
          <span>{t('timed.hoursUnit')}</span>
        </label>
        <button type="button" className="btn primary" disabled={!valid || busy} onClick={grant}>
          {t('timed.confirm', { hours: valid ? hours : '—' })}
        </button>
      </div>
      <div className={valid ? 'timed-hint' : 'timed-hint err'}>
        {valid
          ? t('timed.until', { time: untilText(now + hours * 3_600_000, now, lang), what })
          : t('timed.range', { min: TIMED_APPROVAL_MIN_HOURS, max: TIMED_APPROVAL_MAX_HOURS })}
      </div>
      {error ? <div className="timed-hint err">{error}</div> : null}
    </fieldset>
  ) : null
  return { button, panel }
}
