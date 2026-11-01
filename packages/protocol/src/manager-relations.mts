// 关系的正反向分组两端复用，避免桌面和手机各自解释 derived 的方向。
import type { ManagerRelation, ManagerRelationTarget } from './manager-posts.mjs'
export function relationGroups(
  relations: readonly ManagerRelation[],
  target: ManagerRelationTarget,
) {
  const groups: {
    source: ManagerRelationTarget[]
    derived: ManagerRelationTarget[]
    related: ManagerRelationTarget[]
  } = { source: [], derived: [], related: [] }
  const same = (a: ManagerRelationTarget, b: ManagerRelationTarget) =>
    a.kind === b.kind && a.target === b.target
  for (const edge of relations) {
    const forward = same(edge.from, target)
    const reverse = same(edge.to, target)
    if (!forward && !reverse) continue
    const key = edge.kind === 'related' ? 'related' : forward ? 'source' : 'derived'
    const other = forward ? edge.to : edge.from
    if (!groups[key].some((t) => same(t, other))) groups[key].push(other)
  }
  return groups
}
