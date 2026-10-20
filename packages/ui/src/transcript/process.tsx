// 过程区：用户消息和最终回答之间的那一段。说明段按正文画（和最终回答同一个样子），
// 步骤组收成一行汇总（activity.tsx 的 Steps），启动子代理那一行排在它所在的位置（tree/TreeCards.tsx）。
// 回合结束后整段过程收成一行“已处理 X · N 段说明 · N 步 · N 个子代理”，点开恢复。
import { type ItemView, keys, type ProcessPart, processTally, type TurnView } from '@litch/core'
import { memo, useMemo, useRef } from 'react'
import { useT } from '../app/appearance.ts'
import { duration } from '../app/format.ts'
import { Caret } from '../app/icons.tsx'
import { useKeys } from '../app/services.tsx'
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

/**
 * 回合里还有没做完的子代理吗：有就不自动收起整段过程（照 Codex）。
 * agentItemIds 是这个回合里启动子代理的那几条。
 * 子代理的状态以子线程为准的推导在另一条线上做，主线合并时在这里接上；现在一律当作都做完了
 */
export function useAgentsRunning(_ref: SessionRef, _agentItemIds: string[]): boolean {
  return false
}

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
  const tally = useMemo(
    () => processTally(values.filter((value): value is ItemView => value !== undefined)),
    [values],
  )
  const ended = turn.status === 'failed' || turn.status === 'interrupted' ? turn.status : null
  const time = turn.status !== 'running' && turn.durationMs ? duration(turn.durationMs, t) : null
  const { plain, bad } = processSummary(tally, time, t, ended)
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
    </button>
  )
})
