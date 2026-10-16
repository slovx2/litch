// “计划写好了，要不要执行”：出完计划回合就结束了的引擎（Pi、原生 codex），由这里来问。
// 排在输入框上面、请求卡片的那个位置。三条路：执行；带意见修改（把焦点放进输入框，写了发出去，还在计划模式里）；
// 先不执行（收起，这份计划不再问）。什么时候出见 plan-ask.ts。
import {
  type ItemView,
  keys,
  type SessionMeta,
  type SessionSettings,
  type TurnView,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { planAskedIn, planToConfirm, settledPlan, settlePlan } from './plan-ask.ts'

interface PlanAskProps {
  deviceId: string
  sessionId: string
}

export function PlanAsk({ deviceId, sessionId }: PlanAskProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const session = `${deviceId}:${sessionId}`
  const settings = useKey<SessionSettings>(keys.settings(deviceId, sessionId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const lastId = turnIds?.[turnIds.length - 1] ?? ''
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, lastId))
  /** 正在发“执行”的那一份；点了“先不执行”之后重画一次 */
  const [sending, setSending] = useState<string | null>(null)
  const [, redraw] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const planId = planToConfirm({
    mode: settings?.mode,
    live: meta?.live === true,
    turn,
    // 回合结束时条目都已经到了：这里现取就行，不用一个个订阅
    kindOf: (id) => replica.store.get<ItemView>(keys.item(deviceId, sessionId, id))?.kind,
    asked: planAskedIn(session) === lastId,
    settled: settledPlan(session),
  })
  if (!planId) return null

  const implement = () => {
    setError(null)
    setSending(planId)
    channel
      .command('session.implementPlan', { deviceId, sessionId, text: t('plan.ask.implementText') })
      .catch((reason: unknown) => setError(t('plan.ask.failed', { reason: whyNot(reason, t) })))
      .finally(() => setSending(null))
  }
  const revise = () => {
    document.querySelector<HTMLTextAreaElement>('.main .dock textarea.cmp-text')?.focus()
  }
  const dismiss = () => {
    settlePlan(session, planId)
    redraw((value) => value + 1)
  }

  return (
    <div className="req-slot">
      {/* biome-ignore lint/a11y/useSemanticElements: 一组按钮和一句话，不是表单里的一栏 */}
      <div className="plan-ask" role="group" aria-label={t('plan.ask.title')} data-plan={planId}>
        <div className="plan-ask-text">
          <b>{t('plan.ask.title')}</b>
          <span>{error ?? t('plan.ask.note')}</span>
        </div>
        <div className="plan-ask-acts">
          <button
            type="button"
            className="btn primary"
            data-act="implement"
            disabled={sending !== null}
            onClick={implement}
          >
            {t('plan.ask.implement')}
          </button>
          <button type="button" className="btn ghost" data-act="revise" onClick={revise}>
            {t('plan.ask.revise')}
          </button>
          <button type="button" className="btn ghost" data-act="dismiss" onClick={dismiss}>
            {t('plan.ask.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
