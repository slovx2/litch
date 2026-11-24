// 经理设置“运行环境”页签里的无人值守一节：空闲自动压缩。受控字段，随表单原有的“保存”一起提交。
import { IDLE_COMPACT_MINUTES, IDLE_COMPACT_PERCENT } from '@litch/core'
import { useT } from '../app/appearance.ts'
import type { IdleCompactCheck, IdleCompactDraft } from './idle-compact-draft.ts'

export function IdleCompactFields({
  draft,
  check,
  unavailable,
  linesOnly,
  onChange,
}: {
  draft: IdleCompactDraft
  check: IdleCompactCheck
  /** 还没分配外部来源：整节禁用，并说明原因。 */
  unavailable: boolean
  /** 经理所用 harness 不支持自身压缩：设置只作用于子会话。 */
  linesOnly: boolean
  onChange(next: IdleCompactDraft): void
}) {
  const t = useT()
  const valuesOff = unavailable || !draft.enabled
  const number = (
    field: 'minutes' | 'percent',
    label: string,
    unit: string,
    ok: boolean,
    range: { min: number; max: number },
  ) => {
    const errorId = `manager-idle-${field}-error`
    return (
      <label className="form-field mg-num-field">
        {label}
        <span className="mg-num">
          <input
            type="text"
            inputMode="numeric"
            className={ok ? 'req-input' : 'req-input wrong'}
            data-manager-field={`idleCompact.${field}`}
            data-manager-idle={field}
            value={draft[field]}
            disabled={valuesOff}
            aria-invalid={!ok || undefined}
            aria-describedby={!ok ? errorId : undefined}
            onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
          />
          <span className="mg-num-unit" aria-hidden="true">
            {unit}
          </span>
        </span>
        {!ok ? (
          <small className="form-note err" id={errorId}>
            {t('manager.idleCompact.range', range)}
          </small>
        ) : null}
      </label>
    )
  }
  return (
    <section className="mng-sec mg-idle" data-manager-idle-compact>
      <h2>{t('manager.unattended')}</h2>
      <label className="form-check">
        <input
          type="checkbox"
          data-manager-field="idleCompact"
          checked={draft.enabled}
          disabled={unavailable}
          aria-describedby="manager-idle-note"
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        <span>
          {t('manager.idleCompact.enabled')}
          <br />
          <small id="manager-idle-note" className="form-note">
            {t(unavailable ? 'manager.idleCompact.unavailable' : 'manager.idleCompact.hint')}
            {!unavailable && linesOnly ? (
              <>
                <br />
                <span data-manager-idle-lines-only>{t('manager.idleCompact.linesOnly')}</span>
              </>
            ) : null}
          </small>
        </span>
      </label>
      <div className="mg-idle-values" data-off={valuesOff || undefined}>
        {number(
          'minutes',
          t('manager.idleCompact.minutes'),
          t('manager.idleCompact.minutesUnit'),
          check.minutesOk,
          IDLE_COMPACT_MINUTES,
        )}
        {number(
          'percent',
          t('manager.idleCompact.percent'),
          '%',
          check.percentOk,
          IDLE_COMPACT_PERCENT,
        )}
      </div>
    </section>
  )
}
