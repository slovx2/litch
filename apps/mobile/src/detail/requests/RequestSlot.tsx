// 等着人答复的请求，排在输入框上面：一次只呈现第一个，其余的排着（卡片底下写着还有几个）。
// 输入框一直在、照常能写，请求不挡它；请求挂着时发消息就是“回合进行中发消息”那一套。
// 没有请求的时候这个位置留给“计划写好了，要不要执行”（PlanAsk.tsx）。数据只来自会话存储的 meta。
// 电脑上的代理请求登录、要手机批准的卡片（approvals/）排在最前：代理在等，卡片有的还会过期。它们不在 meta 里，
// 由核心按会话另放（approvals/source.ts）。
import { useEffect, useSyncExternalStore } from 'react'
import { asksAboutPlan, markPlanAsked } from '../../../../../packages/ui/src/composer/plan-ask.ts'
import { keepQuestionDrafts } from '../../../../../packages/ui/src/composer/question-drafts.ts'
import type { SessionStore } from '../../core/session-store'
import { SignInApprovalCard } from '../approvals/SignInApprovalCard'
import { useApprovalCards } from '../approvals/source'
import { ApprovalCard } from './ApprovalCard'
import { CardHeight } from './Card'
import { ClientAskCard } from './ClientAskCard'
import { FormCard } from './FormCard'
import { PlanAsk } from './PlanAsk'
import { QuestionCard } from './QuestionCard'

export function RequestSlot({
  store,
  maxHeight,
  onRevise,
}: {
  store: SessionStore
  /** 卡片最高多少：屏幕上除去标题栏、键盘、输入区之后还剩的地方的一部分 */
  maxHeight: number
  /** “带意见修改”：把焦点放进输入框 */
  onRevise(): void
}) {
  const { deviceId, sessionId } = store
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const approvals = useApprovalCards(deviceId, sessionId)
  const requests = meta?.requests
  // 提问答到一半的内容按请求记着；请求没了就不留了。meta 还没到的时候不清：那是还没载入，不是没了
  useEffect(() => {
    if (requests)
      keepQuestionDrafts(
        deviceId,
        sessionId,
        requests.map((entry) => entry.id),
      )
  }, [deviceId, sessionId, requests])

  const request = requests?.[0]
  const lastTurn = meta?.lastTurn ?? null
  // 引擎自己来问“要不要执行计划”了：记下是在哪个回合里问的，这个回合结束之后客户端不再问一遍
  const planAsked =
    request?.kind === 'question' &&
    asksAboutPlan(
      request.questions.map((entry) => entry.id),
      (lastTurn?.itemIds ?? []).some((id) => store.kindOf(id) === 'plan'),
    )
  useEffect(() => {
    if (planAsked && lastTurn) markPlanAsked(`${deviceId}\n${sessionId}`, lastTurn.id)
  }, [deviceId, sessionId, planAsked, lastTurn])

  const approval = approvals[0]
  if (approval)
    return (
      <CardHeight.Provider value={maxHeight}>
        <SignInApprovalCard
          key={approval.id}
          deviceId={deviceId}
          card={approval}
          waiting={approvals.length - 1 + (requests?.length ?? 0)}
        />
      </CardHeight.Provider>
    )
  if (!meta) return null
  const waiting = (requests?.length ?? 1) - 1
  const common = { deviceId, sessionId, waiting }
  return (
    <CardHeight.Provider value={maxHeight}>
      {!request ? (
        <PlanAsk store={store} meta={meta} onRevise={onRevise} />
      ) : request.kind === 'approval' ? (
        <ApprovalCard key={request.id} {...common} request={request} />
      ) : request.kind === 'question' ? (
        <QuestionCard key={request.id} {...common} request={request} />
      ) : request.kind === 'form' ? (
        <FormCard key={request.id} {...common} request={request} />
      ) : (
        <ClientAskCard key={request.id} {...common} request={request} />
      )}
    </CardHeight.Provider>
  )
}
