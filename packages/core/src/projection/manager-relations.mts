import type { ManagerRelationTarget } from '../../../protocol/src/manager-posts.mjs'
import { relationGroups } from '../../../protocol/src/manager-relations.mjs'
import type { ManagerBoardView } from '../model-manager.mjs'

/** 关系和对象内的链接共用一个展示集合；投影出的同一链接不重复画。 */
export function managerRelationGroups(board: ManagerBoardView, target: ManagerRelationTarget) {
  const groups = relationGroups(board.relations ?? [], target)
  const object =
    target.kind === 'item'
      ? board.items.find((item) => item.id === target.target)
      : board.requests?.find((item) => item.id === target.target)
  for (const [group, links] of [
    ['source', object?.basis ?? []],
    ['related', object?.links ?? []],
  ] as const) {
    for (const link of links) {
      if (
        !Object.values(groups)
          .flat()
          .some((entry) => entry.kind === link.kind && entry.target === link.target)
      )
        groups[group].push({
          kind: link.kind,
          target: link.target,
          ...(link.label ? { label: link.label } : {}),
        })
    }
  }
  const seen = new Set<string>()
  for (const group of ['source', 'derived', 'related'] as const) {
    groups[group] = groups[group].filter((entry) => {
      const key = `${entry.kind}:${entry.target}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return groups
}
