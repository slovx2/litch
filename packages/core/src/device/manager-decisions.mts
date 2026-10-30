// 只比较连续在线的看板。变更记录补上两次读取之间先关闭、再重新打开的情况。
import type { ManagerBoardView, ManagerDecisionView } from '../model-manager.mjs'

export function openedManagerDecisions(
  before: ManagerBoardView | null,
  after: ManagerBoardView,
): ManagerDecisionView[] {
  if (!before) return []
  const previous = new Map(before.decisions.map((decision) => [decision.id, decision]))
  const changes = new Set(before.changes.map((change) => change.id))
  const reopened = new Set(
    after.changes
      .filter(
        (change) =>
          !changes.has(change.id) &&
          change.before?.status !== 'open' &&
          change.after?.status === 'open' &&
          typeof change.after.revision === 'number' &&
          change.after.revision >
            (previous.get(change.objectId as ManagerDecisionView['id'])?.revision ?? 0),
      )
      .map((change) => change.objectId),
  )
  return after.decisions.filter(
    (decision) =>
      decision.status === 'open' &&
      (previous.get(decision.id)?.status !== 'open' || reopened.has(decision.id)),
  )
}
