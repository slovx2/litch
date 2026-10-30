// 根据实际筛选后的树找路径；折叠和“展示更多”不参与筛选，定位时再展开。
import type { SessionChildren, SessionGroups } from '@litch/core'
import { MAX_DEPTH, nestedUnder } from './tree.ts'

export interface RevealPath {
  group: string
  rootIndex: number
  ids: string[]
}

export function revealPath(
  target: string,
  groups: SessionGroups,
  children: SessionChildren,
  shown: (ids: readonly string[]) => readonly string[],
  managerRoot?: string,
): RevealPath | null {
  const paths = new Map<string, RevealPath>()
  const walk = (id: string, path: RevealPath, depth: number) => {
    if (depth > MAX_DEPTH || paths.has(id)) return
    paths.set(id, path)
    for (const child of shown(children[id] ?? []))
      walk(child, { ...path, ids: [...path.ids, child] }, depth + 1)
  }
  if (managerRoot) {
    for (const [index, id] of (children[managerRoot] ?? []).entries())
      walk(id, { group: '', rootIndex: index, ids: [id] }, 1)
  } else {
    const filtered = Object.fromEntries(
      Object.entries(groups).map(([group, ids]) => [group, shown(ids)]),
    )
    const nested = nestedUnder(Object.values(filtered).flat(), children)
    for (const [group, ids] of Object.entries(filtered)) {
      for (const [index, id] of ids.filter((id) => !nested.has(id)).entries())
        walk(id, { group, rootIndex: index, ids: [id] }, 0)
    }
  }
  // 目标被隐藏或超过最大深度：沿原始父链找最近能画出来的祖先，不改筛选开关。
  const parents = new Map<string, string>()
  for (const [parent, kids] of Object.entries(children))
    for (const child of kids) parents.set(child, parent)
  const visited = new Set<string>()
  for (let id: string | undefined = target; id && !visited.has(id); id = parents.get(id)) {
    const path = paths.get(id)
    if (path) return path
    visited.add(id)
  }
  return null
}

/** 只滚侧栏自己的容器；已经完整可见时保留用户的位置。 */
export function revealRow(row: HTMLElement, scroll: HTMLElement): void {
  const box = row.getBoundingClientRect()
  const viewport = scroll.getBoundingClientRect()
  if (box.top >= viewport.top && box.bottom <= viewport.bottom) return
  scroll.scrollTop += (box.top + box.bottom - viewport.top - viewport.bottom) / 2
}

/** 经理列表按自己的根分组；选中根或任意后代时展开同一组。 */
export function containsSession(children: SessionChildren, root: string, target: string): boolean {
  const seen = new Set<string>()
  const pending = [root]
  while (pending.length) {
    const id = pending.pop()
    if (!id || seen.has(id)) continue
    if (id === target) return true
    seen.add(id)
    pending.push(...(children[id] ?? []))
  }
  return false
}
