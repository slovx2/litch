// 父会话只订阅用户展开的那一个子会话，回答仍使用子会话原请求及原通道。
// 样子和待答问题（PendingQuestions.tsx）同一种卡片、同一个位置：和输入区一样宽，等待色的边，标题一行可收起；
// 每个停着的子会话一行（徽标、标题、在等什么），点开在卡片里画它的请求卡（去掉自己的边框，不套两层）
import {
  type DeviceView,
  keys,
  type RequestView,
  type SessionChildren,
  type SessionSummary,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { badgeOf } from '../app/device.ts'
import { Caret, Icon } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { CompactRow } from '../transcript/CompactRow.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { useToggle } from '../transcript/state.ts'
import { delegatedPairs } from './delegated-response.ts'
import { RequestCard } from './RequestCard.tsx'

export function ChildRequests({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const children = useKey<SessionChildren>(keys.children(deviceId))?.[sessionId] ?? []
  const summaries = useKeys<SessionSummary>(children.map((id) => keys.summary(deviceId, id)))
  const [expanded, setExpanded] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const waiting = summaries.filter(
    (summary): summary is SessionSummary => (summary?.pendingRequests?.length ?? 0) > 0,
  )
  if (!waiting.length) return null
  return (
    <div className="req-slot">
      <section className="pending-asks child-reqs" aria-label={t('ask.children')}>
        <button
          type="button"
          className="pending-asks-head"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <i className="st wait" />
          <span className="grow">{t('ask.childrenCount', { count: waiting.length })}</span>
          <Caret />
        </button>
        {expanded ? (
          <div className="pending-asks-body">
            {waiting.map((child) => {
              const open = selected === child.id
              return (
                <div className="child-req" key={child.id} data-child={child.id}>
                  <div className="child-req-line">
                    <button
                      type="button"
                      className="child-req-toggle"
                      aria-expanded={open}
                      onClick={() => setSelected(open ? null : child.id)}
                    >
                      <span className="chip">{badgeOf(device, child.harness)}</span>
                      <span className="child-req-title">{t.text(child.title)}</span>
                      <span className="child-req-what">{child.pendingRequests?.[0]?.title}</span>
                      <Caret />
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => requestOpenSession({ deviceId, sessionId: child.id })}
                    >
                      {t('tree.child.open')}
                    </button>
                  </div>
                  {open ? <ChildRequest deviceId={deviceId} child={child} /> : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </section>
    </div>
  )
}

function ChildRequest({ deviceId, child }: { deviceId: string; child: SessionSummary }) {
  const t = useT()
  const { replica } = useServices()
  useEffect(() => replica.openSession(deviceId, child.id), [replica, deviceId, child.id])
  const requests = useKey<RequestView[]>(keys.requests(deviceId, child.id)) ?? []
  const request = requests[0]
  return (
    <div className="child-req-body">
      {request ? (
        <RequestCard
          key={request.id}
          deviceId={deviceId}
          sessionId={child.id}
          request={request}
          waiting={requests.length - 1}
        />
      ) : (
        <p className="child-req-note">{t('ask.childUnavailable')}</p>
      )}
    </div>
  )
}

/**
 * 别的会话替这个会话答过的请求（设备记的历史，不伪造子会话的用户消息；重新打开仍从设备快照读取）。
 * 画在对话最上面，样子同系统消息（CompactRow）：标题行是“代答记录 · N 条”和最近一条是谁代答的，
 * 收着时下面一行是最近一条的问答；点开逐条列出谁、什么时候、问了什么、答了什么
 */
export function DelegatedHistory({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const [open, setOpen] = useToggle(`${deviceId}:${sessionId}`, 'delegated', false)
  const records =
    useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.delegatedResponses ?? []
  if (!records.length) return null
  const by = (record: (typeof records)[number]) =>
    t(record.parent ? 'ask.delegatedParent' : 'ask.delegatedSession', {
      name: record.sourceTitle || record.sourceThreadId,
    })
  const latest = records.at(-1) as (typeof records)[number]
  return (
    <div className="sev sysm delegated" data-delegated-history="">
      <CompactRow
        icon={<Icon name="note" small />}
        source={t('ask.delegatedHistory', { count: records.length })}
        title={open ? undefined : by(latest)}
        summary={delegatedPairs(latest, t)
          .map((pair) => `${pair.question} → ${pair.answer}`)
          .join(' · ')}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      {open
        ? records.map((record) => (
            <div
              className="delegated-one"
              key={record.id}
              data-delegated-by={record.sourceThreadId}
            >
              <div className="delegated-by">
                <span className="ell">{by(record)}</span>
                <Stamp at={record.at} />
              </div>
              {delegatedPairs(record, t).map((pair, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 记录写下之后不会变
                <div className="delegated-pair" key={at}>
                  <div className="delegated-q">{pair.question}</div>
                  <div className="ask-answer">
                    <span className="ask-answer-label">{t('ask.answer')}</span>
                    <div>{pair.answer}</div>
                  </div>
                </div>
              ))}
            </div>
          ))
        : null}
    </div>
  )
}
