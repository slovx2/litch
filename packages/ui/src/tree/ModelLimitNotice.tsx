// 开始子会话时模型越级的提示：建议卡、任务卡（提案）和“派一个子会话”弹窗共用。
// 一句话说清哪个模型高于父会话的哪个模型（或有一方未分级），
// 就地给“改用一个允许的模型开始”，再给跳去改经理默认模型、调整模型等级的入口。
import { keys, managerMark, type SessionSummary } from '@litch/core'
import { useState } from 'react'
import { requestDevice, requestManagerSettings } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import {
  allowedChoices,
  defaultChoice,
  LIMIT_TARGET_TEXT,
  type ModelLimitFailureView,
  type ModelLimitSettingsTarget,
} from './model-limit.ts'

/** 跳去对应的设置 */
export function openLimitTarget(target: ModelLimitSettingsTarget): void {
  if (target.kind === 'model-ranking') requestDevice(target.deviceId, 'ranking')
  else requestManagerSettings({ deviceId: target.deviceId, sessionId: target.sessionId })
}

export function ModelLimitNotice({
  limit,
  busy,
  onUseModel,
}: {
  limit: ModelLimitFailureView
  busy: boolean
  /** 改用这个模型开始 */
  onUseModel(choice: { harness: string; model: string }): void
}) {
  const t = useT()
  const choices = allowedChoices(limit)
  const [picked, setPicked] = useState(() => defaultChoice(limit, choices))
  const choice = choices.find((entry) => entry.model === picked)
  return (
    <div className="limit-note" role="alert" data-model-limit={limit.reason.kind}>
      <p className="limit-text">{t.text(limit.text)}</p>
      {choices.length > 0 ? (
        <div className="limit-use">
          <select
            className="req-input"
            aria-label={t('limit.pick')}
            value={picked}
            disabled={busy}
            onChange={(event) => setPicked(event.target.value)}
          >
            {choices.map((entry) => (
              <option key={`${entry.harness}:${entry.model}`} value={entry.model}>
                {entry.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            data-act="limit-use"
            disabled={busy || !choice}
            onClick={() => choice && onUseModel(choice)}
          >
            {t('limit.start')}
          </button>
        </div>
      ) : (
        <p className="limit-none">{t('limit.none')}</p>
      )}
      {limit.settings.length > 0 ? (
        <div className="limit-links">
          {limit.settings.map((target) => (
            <LimitLink key={target.kind} target={target} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 一个跳转。“改经理默认模型”只在父会话是经理时给：别的父会话没有可改的默认模型 */
function LimitLink({ target }: { target: ModelLimitSettingsTarget }) {
  const t = useT()
  const parent = useKey<SessionSummary>(
    target.kind === 'manager-default-model' ? keys.summary(target.deviceId, target.sessionId) : '',
  )
  if (
    target.kind === 'manager-default-model' &&
    (!parent || managerMark(parent)?.role !== 'manager')
  )
    return null
  return (
    <button
      type="button"
      className="mini"
      data-act={`limit-${target.kind}`}
      onClick={() => openLimitTarget(target)}
    >
      {t(LIMIT_TARGET_TEXT[target.kind])}
    </button>
  )
}
