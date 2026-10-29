// 父会话只订阅用户展开的那一个子会话，回答仍使用子会话原请求及原通道。
import { keys, type RequestView, type SessionChildren, type SessionSummary } from '@litch/core'
import { useEffect, useState } from 'react'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { delegatedResponseText } from './delegated-response.ts'
import { RequestCard } from './RequestCard.tsx'

export function ChildRequests({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const children = useKey<SessionChildren>(keys.children(deviceId))?.[sessionId] ?? []
  const summaries = useKeys<SessionSummary>(children.map((id) => keys.summary(deviceId, id)))
  const [selected, setSelected] = useState<string | null>(null)
  const waiting = summaries.filter((s) => s?.pendingRequests?.length)
  if (!waiting.length) return null
  return (
    <section className="pending-asks" aria-label={t('ask.children')}>
      <div className="pending-asks-head">{t('ask.children')}</div>
      <div className="pending-asks-body">
        {waiting.map((child) =>
          child ? (
            <div key={child.id}>
              <button
                type="button"
                className="compact-message"
                aria-expanded={selected === child.id}
                onClick={() => setSelected(selected === child.id ? null : child.id)}
              >
                <span className="chip">{child.harness}</span>
                <span className="ell">{t.text(child.title)}</span>
                <span className="ell grow">{child.pendingRequests?.[0]?.title}</span>
                <span>{selected === child.id ? '⌄' : '›'}</span>
              </button>
              {selected === child.id ? <ChildRequest deviceId={deviceId} child={child} /> : null}
            </div>
          ) : null,
        )}
      </div>
    </section>
  )
}

function ChildRequest({ deviceId, child }: { deviceId: string; child: SessionSummary }) {
  const t = useT()
  const { replica } = useServices()
  useEffect(() => replica.openSession(deviceId, child.id), [replica, deviceId, child.id])
  const requests = useKey<RequestView[]>(keys.requests(deviceId, child.id)) ?? []
  const request = requests[0]
  return (
    <div>
      <button
        type="button"
        className="mini"
        onClick={() => requestOpenSession({ deviceId, sessionId: child.id })}
      >
        {t('tree.child.open')}
      </button>
      {request ? (
        <RequestCard
          key={request.id}
          deviceId={deviceId}
          sessionId={child.id}
          request={request}
          waiting={requests.length - 1}
        />
      ) : (
        <p className="dim">{t('ask.childUnavailable')}</p>
      )}
    </div>
  )
}

/** 独立的设备历史记录，不伪造子会话用户消息；重新打开仍从设备快照读取。 */
export function DelegatedHistory({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const records =
    useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.delegatedResponses ?? []
  if (!records.length) return null
  return (
    <details className="ask delegated-history" data-delegated-history="">
      <summary className="ask-head">{t('ask.delegatedHistory', { count: records.length })}</summary>
      {records.map((record) => (
        <div className="ask-q" key={record.id} data-delegated-by={record.sourceThreadId}>
          <b>
            {t(record.parent ? 'ask.delegatedParent' : 'ask.delegatedSession', {
              name: record.sourceTitle || record.sourceThreadId,
            })}
          </b>
          <time>{new Date(record.at).toLocaleString()}</time>
          <div className="sysm-full">{delegatedResponseText(record, t)}</div>
        </div>
      ))}
    </details>
  )
}
