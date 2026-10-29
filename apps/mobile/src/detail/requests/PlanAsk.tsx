// “计划写好了，要不要执行”：出完计划回合就结束了的引擎（原生 codex），由这里来问。排在请求卡片的位置。
// 三条路：执行（session.implementPlan）；带意见修改（焦点放进输入框，写了发出去，还在计划模式里）；
// 先不执行（收起，这份计划不再问）。什么时候出见桌面的 composer/plan-ask.ts。
import { useState } from 'react'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  planAskedIn,
  planToConfirm,
  settledPlan,
  settlePlan,
} from '../../../../../packages/ui/src/composer/plan-ask.ts'
import type { SessionMeta, SessionStore } from '../../core/session-store'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Card, CardButton, Why } from './Card'

export function PlanAsk({
  store,
  meta,
  onRevise,
}: {
  store: SessionStore
  meta: SessionMeta
  onRevise(): void
}) {
  const { deviceId, sessionId } = store
  const channel = useChannel()
  const t = useT()
  const session = `${deviceId}\n${sessionId}`
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, redraw] = useState(0)
  const planId = planToConfirm({
    mode: meta.settings.mode,
    live: meta.live,
    turn: meta.planTurn ?? undefined,
    // 回合结束时条目都已经到了：现取就行
    kindOf: store.kindOf,
    asked: meta.planTurn !== null && planAskedIn(session) === meta.planTurn.id,
    settled: settledPlan(session),
  })
  if (!planId) return null
  const implement = () => {
    setError(null)
    setSending(true)
    channel
      .command('session.implementPlan', { deviceId, sessionId, text: t('plan.ask.implementText') })
      .catch((reason: unknown) => setError(t('plan.ask.failed', { reason: whyNot(reason, t) })))
      .finally(() => setSending(false))
  }
  const dismiss = () => {
    settlePlan(session, planId)
    redraw((value) => value + 1)
  }
  return (
    <Card
      testID="request:plan"
      title={t('plan.ask.title')}
      waiting={0}
      error={error}
      actions={
        <>
          <CardButton
            kind="primary"
            testID="plan:implement"
            label={t('plan.ask.implement')}
            disabled={sending}
            onPress={implement}
          />
          <CardButton testID="plan:revise" label={t('plan.ask.revise')} onPress={onRevise} />
          <CardButton
            kind="ghost"
            testID="plan:dismiss"
            label={t('plan.ask.dismiss')}
            onPress={dismiss}
          />
        </>
      }
    >
      <Why>{t('plan.ask.note')}</Why>
    </Card>
  )
}
