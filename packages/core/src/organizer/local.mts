// 本机组的实体投影：置顶优先、显式会话优先；收起与展开不会改变实体归属。
// 桌面和手机共用，跨组也去重，引用与原有位置始终留在文件里。
import type { WorkspaceView } from '../model.mjs'
import type { SessionChildren, SessionGroups } from '../replica/replica.mjs'
import { type LocalGroup, type MemberRef, refKey } from './file.mjs'

export interface LocalCatalog {
  deviceId: string
  groups: SessionGroups | undefined
  children: SessionChildren | undefined
  workspaces: readonly WorkspaceView[] | undefined
  covered: readonly string[] | undefined
}

export interface MemberTree {
  roots: string[]
  /** 此成员的树不能再画的会话：置顶的、或已归给其他显式成员的。 */
  excluded: ReadonlySet<string>
}

export interface LocalLayout {
  groups: ReadonlyMap<string, { visible: MemberRef[]; pinned: number }>
  trees: ReadonlyMap<string, MemberTree>
}

/** 同一个实体只画一次；显式会话及其子树先认领，项目随后认领剩余的树。 */
export function localLayout(
  groups: readonly LocalGroup[],
  catalogs: readonly LocalCatalog[],
): LocalLayout {
  const sources = new Map(catalogs.map((catalog) => [catalog.deviceId, catalog]))
  const projected = new Map<string, { visible: MemberRef[]; pinned: number }>()
  const members: MemberRef[] = []
  for (const group of groups) {
    const visible = group.members.filter((ref) => {
      const source = sources.get(ref.deviceId)
      return ref.kind === 'session'
        ? !source?.covered?.includes(ref.sessionId)
        : !source?.workspaces?.some(
            (workspace) => workspace.id === ref.workspaceId && workspace.pinned,
          )
    })
    projected.set(group.id, { visible, pinned: group.members.length - visible.length })
    members.push(...visible)
  }
  const owners = new Map<string, Map<string, string>>()
  for (const source of catalogs)
    owners.set(source.deviceId, new Map((source.covered ?? []).map((id) => [id, ':pinned'])))
  for (const member of members) {
    if (!owners.has(member.deviceId)) owners.set(member.deviceId, new Map())
    if (member.kind === 'session')
      owners.get(member.deviceId)?.set(member.sessionId, refKey(member))
  }
  const roots = new Map<string, string[]>()
  const ordered = [
    ...members.filter((ref) => ref.kind === 'session'),
    ...members.filter((ref) => ref.kind === 'workspace'),
  ]
  for (const member of ordered) {
    const source = sources.get(member.deviceId)
    const children = source?.children ?? {}
    const key = refKey(member)
    const owned = owners.get(member.deviceId) as Map<string, string>
    const ids =
      member.kind === 'session' ? [member.sessionId] : (source?.groups?.[member.workspaceId] ?? [])
    const nested = new Set(
      ids.flatMap((id) => (children[id] ?? []).filter((kid) => ids.includes(kid))),
    )
    const top = ids.filter((id) => !nested.has(id) && (!owned.has(id) || owned.get(id) === key))
    const visited = new Set<string>()
    const claim = (id: string, depth: number): void => {
      if (depth > 8 || visited.has(id) || (owned.has(id) && owned.get(id) !== key)) return
      visited.add(id)
      owned.set(id, key)
      for (const kid of children[id] ?? []) claim(kid, depth + 1)
    }
    for (const id of top) claim(id, 0)
    roots.set(key, top)
  }
  const trees = new Map<string, MemberTree>()
  for (const member of members) {
    const key = refKey(member)
    const excluded = new Set(
      [...(owners.get(member.deviceId) ?? [])]
        .filter(([, owner]) => owner !== key)
        .map(([id]) => id),
    )
    trees.set(key, { roots: roots.get(key) ?? [], excluded })
  }
  return { groups: projected, trees }
}
