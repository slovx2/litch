// 过程区：用户消息和最终回答之间的那一段。说明段按正文画（和最终回答同一个样子），
// 步骤组收成一行汇总（activity.tsx 的 Steps），启动子代理那一行排在它所在的位置（tree/TreeCards.tsx）。
// 回合结束后整段过程收成一行“已处理 X · N 段说明 · N 步 · N 个子代理”，点开恢复；
// 这一轮起的后台任务还在跑的，末尾再加“· N 个在后台运行”。
import {
  type ItemView,
  keys,
  type ProcessPart,
  processTally,
  runningFromTurn,
  type TurnView,
} from '@litch/core'
import { memo, useMemo, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { duration } from '../app/format.ts'
import { Caret } from '../app/icons.tsx'
import { useKeys } from '../app/services.tsx'
import { useSessionBackground } from '../background/state.ts'
import { useAgents } from '../tree/agent-view.tsx'
import { TreeCard } from '../tree/TreeCards.tsx'
import { Steps } from './activity.tsx'
import { AgentAnswer } from './messages.tsx'
import { usePin } from './scroll.ts'
import { processSummary } from './steps-text.ts'

interface SessionRef {
  deviceId: string
  sessionId: string
}

/** 一段过程里的东西，按时间排 */
export const ProcessParts = memo(function ProcessParts({
  parts,
  live,
  ...ref
}: SessionRef & { parts: ProcessPart[]; live: boolean }) {
  return parts.map((part) => {
    if (part.type === 'note') return <AgentAnswer key={part.itemId} {...ref} itemId={part.itemId} />
    if (part.type === 'card') return <TreeCard key={part.itemId} {...ref} itemId={part.itemId} />
    return <Steps key={part.key} {...ref} groupKey={part.key} itemIds={part.itemIds} live={live} />
  })
})

interface ProcessHeadProps extends SessionRef {
  turn: TurnView
  /** 整段过程里所有条目的标识 */
  itemIds: string[]
  open: boolean
  onToggle(next: boolean): void
}

/** 回合结束后整段过程收成的那一行。失败、被拒、出错的个数红字标在行尾 */
export const ProcessHead = memo(function ProcessHead({
  deviceId,
  sessionId,
  turn,
  itemIds,
  open,
  onToggle,
}: ProcessHeadProps) {
  const t = useT()
  const pin = usePin()
  const head = useRef<HTMLButtonElement | null>(null)
  const itemKeys = useMemo(
    () => itemIds.map((itemId) => keys.item(deviceId, sessionId, itemId)),
    [deviceId, sessionId, itemIds],
  )
  const values = useKeys<ItemView>(itemKeys)
  // 失败的子代理以子线程为准，不看派出时那份快照
  const agents = useAgents(deviceId, sessionId)
  const tally = useMemo(
    () =>
      processTally(
        values.filter((value): value is ItemView => value !== undefined),
        agents,
      ),
    [values, agents],
  )
  const ended = turn.status === 'failed' || turn.status === 'interrupted' ? turn.status : null
  const time = turn.status !== 'running' && turn.durationMs ? duration(turn.durationMs, t) : null
  const { plain, bad } = processSummary(tally, time, t, ended)
  const background = useSessionBackground(deviceId, sessionId)
  const inBackground = turn.status === 'running' ? 0 : runningFromTurn(background, turn)
  return (
    <button
      type="button"
      className="proc-head"
      data-anchor={`p:${turn.id}`}
      ref={head}
      aria-expanded={open}
      onClick={() => {
        pin(head.current)
        onToggle(!open)
      }}
    >
      <Caret />
      {[...plain, ...bad].map((text, index) => (
        <span key={text} className={index < plain.length ? undefined : 'bad'}>
          {index > 0 ? <span className="sep">·</span> : null}
          {text}
        </span>
      ))}
      {/* 这一轮起的后台任务还在跑：末尾一个呼吸点加个数 */}
      {inBackground > 0 ? (
        <span className="bgmark" data-background={inBackground}>
          <span className="sep">·</span>
          <i className="pulse" aria-hidden="true" />
          {t('background.inTurn', { count: inBackground })}
        </span>
      ) : null}
    </button>
  )
})
