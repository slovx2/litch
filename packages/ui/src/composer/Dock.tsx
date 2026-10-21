// 对话区下面的两样东西：输入区（Dock），和等着回答的请求（Requests）。
// 对面停下来等审批或回答时，请求卡片出现在输入框上面，输入框照常在、照常能写——请求不能把它挡住
// （对话流里只留痕）。两样在主区域里各占一行：地方不够时压的是卡片那一行（它在里面自己滚），
// 输入区不伸不缩，见 dock.css 的 .req-slot。
// 请求还挂着的时候发消息，就是“回合进行中发消息”那一套：排队，或者人选了现在就说，没有另外的规矩。
import {
  type DeviceView,
  type ItemView,
  keys,
  type RequestView,
  type SessionMeta,
  type TurnView,
} from '@litch/core'
import { useEffect, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { downHarness, downText, wireStyle } from '../app/device.ts'
import { useKey, useServices } from '../app/services.tsx'
import { BackgroundBar } from '../background/BackgroundBar.tsx'
import { GoalBar } from '../goal/GoalBar.tsx'
import { SessionComposer } from './Composer.tsx'
import { PlanAsk } from './PlanAsk.tsx'
import { asksAboutPlan, markPlanAsked } from './plan-ask.ts'
import { keepQuestionDrafts } from './question-drafts.ts'
import { RequestCard } from './RequestCard.tsx'

interface DockProps {
  deviceId: string
  sessionId: string
}

/** 输入区。有没有请求等着，它都在 */
export function Dock({ deviceId, sessionId }: DockProps) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const offline = device !== undefined && device.connection !== 'online'
  // 设备连着，但这个会话所属的 harness 现在用不了：照样能看、能写草稿，只是发不出去
  const down = downHarness(device, meta?.harness)
  const blocked = offline ? t('composer.offline') : down ? downText(down, 'composer', t) : null

  let body = null
  if (!meta) {
    // 会话还没载入：先占着位置，免得载入完成时对话区的高度跳一下
    body = (
      <div className="cmp off">
        <div className="cmp-text" />
      </div>
    )
  } else if (!meta.live) {
    body = (
      <div className="cmp off">
        <div className="cmp-text">{meta.note ? t.text(meta.note) : t('composer.offline')}</div>
      </div>
    )
  } else {
    body = (
      <>
        {meta.note ? <div className="cmp-hint err">{t.text(meta.note)}</div> : null}
        {/* 会话有持续目标：一行，状态、目标和用量，点开右侧的“目标”页 */}
        <GoalBar deviceId={deviceId} sessionId={sessionId} />
        {/* 回合停了、后台还有任务在跑：一行，只说有几个，点开右侧的“后台任务”页 */}
        <BackgroundBar deviceId={deviceId} sessionId={sessionId} />
        <SessionComposer deviceId={deviceId} sessionId={sessionId} blocked={blocked} />
      </>
    )
  }
  return (
    <div className="dock" style={wireStyle(device?.wire)}>
      <div className="dock-in">{body}</div>
    </div>
  )
}

/**
 * 等着回答的请求（审批、提问、表单）：一张卡片，排在输入框上面。一次只呈现一个，其余的排着。
 * 会话还没载入的时候不出（下面的输入区那时也只是个占位置的空框）。
 * 没有请求的时候这个位置留给“计划写好了，要不要执行”（PlanAsk.tsx）。
 */
export function Requests({ deviceId, sessionId }: DockProps) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const pending = useKey<RequestView[]>(keys.requests(deviceId, sessionId))
  const requests = pending ?? []
  const request = meta ? requests[0] : undefined

  // 提问答到一半的内容按请求记着；请求没了（答了、别处答了、回合结束）就不留了。
  // 请求列表还没到的时候不清：那是还没载入，不是没了
  useEffect(() => {
    if (pending) {
      keepQuestionDrafts(
        deviceId,
        sessionId,
        pending.map((entry) => entry.id),
      )
    }
  }, [deviceId, sessionId, pending])

  // 请求都答完了、卡片没了：原来在卡片里的焦点落了空，还给输入框，接着就能打字。
  // 人把焦点放到了别处（侧栏的某一行、别的输入框）的不动。还排着下一个请求的话，下一张卡片自己会拿
  const asking = request !== undefined
  const asked = useRef(false)
  useEffect(() => {
    if (asking) {
      asked.current = true
      return
    }
    if (!asked.current) return
    asked.current = false
    const active = document.activeElement
    if (active && active !== document.body) return
    document
      .querySelector<HTMLElement>('.main .dock textarea.cmp-text')
      ?.focus({ preventScroll: true })
  }, [asking])

  // 引擎自己来问“要不要执行计划”了：记下是在哪个回合里问的，这个回合结束之后客户端不再问一遍
  const { replica } = useServices()
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const lastTurn = turnIds?.[turnIds.length - 1]
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, lastTurn ?? ''))
  const planAsked =
    request?.kind === 'question' &&
    asksAboutPlan(
      request.questions.map((entry) => entry.id),
      (turn?.itemIds ?? []).some(
        (id) => replica.store.get<ItemView>(keys.item(deviceId, sessionId, id))?.kind === 'plan',
      ),
    )
  useEffect(() => {
    if (planAsked && lastTurn) markPlanAsked(`${deviceId}:${sessionId}`, lastTurn)
  }, [deviceId, sessionId, planAsked, lastTurn])

  // 没有请求等着的时候：计划写好了、还没人拿主意的话，这里问一句
  if (!request) return meta ? <PlanAsk deviceId={deviceId} sessionId={sessionId} /> : null
  return (
    <div className="req-slot" style={wireStyle(device?.wire)}>
      <RequestCard
        key={request.id}
        deviceId={deviceId}
        sessionId={sessionId}
        request={request}
        waiting={requests.length - 1}
      />
    </div>
  )
}
