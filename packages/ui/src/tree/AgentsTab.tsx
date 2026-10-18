// 侧面板的“子代理”标签：眼前这个会话里引擎自己派出的子代理（原生 codex 的子线程）。
// 上面一排是它们（昵称、角色、状态），下面是正看着的那一个的对话：读历史、跟着更新。
// 能不能在里面直接输入照 canAcceptDirectInput：不能的，核心把会话标成只能看，输入框换成一句说明。
import { useT } from '../app/appearance.ts'
import type { SideTabProps } from '../side/tabs.ts'
import { Transcript } from '../transcript/Transcript.tsx'
import { pickAgent, usePickedAgent } from './agents.ts'
import { markOf } from './TreeCards.tsx'
import { useAgentList } from './useAgentList.ts'

export function AgentsTab({ place, shown }: SideTabProps) {
  const t = useT()
  const { deviceId, sessionId } = place
  const list = useAgentList(deviceId, sessionId, '', shown) ?? []
  const picked = usePickedAgent(deviceId, sessionId)
  const current = picked ?? list[0]?.id ?? null
  if (!sessionId || (list.length === 0 && current === null)) {
    return <div className="side-none dim">{t('agents.none')}</div>
  }
  return (
    <div className="agents-tab" data-parent={sessionId}>
      {list.length > 0 ? (
        <div className="agents-list" role="tablist" aria-label={t('agents.list')}>
          {list.map((agent, index) => {
            const mark = markOf(agent.status)
            return (
              <button
                key={agent.id}
                type="button"
                role="tab"
                className="agents-pick"
                data-agent={agent.id}
                aria-selected={agent.id === current}
                title={agent.title || undefined}
                onClick={() => pickAgent(deviceId, sessionId, agent.id)}
              >
                <i className={mark ? `st ${mark}` : 'st'} />
                <b>{agent.nickname ?? t('tree.agent.unnamed', { n: index + 1 })}</b>
                {agent.role ? <span className="dim">{agent.role}</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}
      {current ? (
        <div className="agents-view main-like" data-agent={current}>
          <Transcript key={current} deviceId={deviceId} sessionId={current} />
        </div>
      ) : null}
    </div>
  )
}
