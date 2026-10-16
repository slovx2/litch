import { isAbsolute } from 'node:path'
import type { Project, ProjectFields, ProjectStore } from './project-store.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'

function roots(value: unknown): ProjectFields['roots'] {
  if (!Array.isArray(value)) throw new ProtocolError(-32602, 'roots 必须是数组')
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      !isAbsolute(entry.path)
    )
      throw new ProtocolError(-32602, '项目根目录必须是绝对路径')
    return { path: entry.path }
  })
}

function metadata(value: unknown): Record<string, string> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  )
    throw new ProtocolError(-32602, 'metadata 必须是字符串字典')
  return { ...value } as Record<string, string>
}

function projectPage(store: ProjectStore, params: Record<string, unknown>): unknown {
  const limit = params.limit ?? 50
  const key = params.sortKey ?? 'position'
  const direction = params.sortDirection ?? (key === 'position' ? 'asc' : 'desc')
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ProtocolError(-32602, 'limit 必须在 1 到 1000 之间')
  if (key !== 'position' && key !== 'recencyAt') throw new ProtocolError(-32602, 'sortKey 无效')
  if (
    (direction !== 'asc' && direction !== 'desc') ||
    (params.sortDirection != null && params.sortKey == null)
  )
    throw new ProtocolError(-32602, 'sortDirection 无效或缺少 sortKey')
  type Boundary = { id: string; value: number | null }
  const boundary = (project: Project): Boundary => ({ id: project.id, value: project[key] })
  const compare = (a: Boundary, b: Boundary): number => {
    if (a.value === null && b.value !== null) return 1
    if (a.value !== null && b.value === null) return -1
    return (
      ((a.value ?? 0) - (b.value ?? 0) || a.id.localeCompare(b.id)) * (direction === 'asc' ? 1 : -1)
    )
  }
  const scope = `projects:${key}:${direction}`
  let cursor: Boundary | null = null
  if (params.cursor != null) {
    try {
      const parsed = JSON.parse(
        Buffer.from(requiredString(params.cursor, 'cursor'), 'base64url').toString(),
      )
      if (
        parsed.scope !== scope ||
        (parsed.value !== null && !Number.isSafeInteger(parsed.value)) ||
        (key === 'position' && parsed.value === null)
      )
        throw new Error('游标范围无效')
      cursor = { id: requiredString(parsed.id, 'cursor.id'), value: parsed.value }
    } catch {
      throw new ProtocolError(-32602, '项目游标无效或不属于本次查询')
    }
  }
  const ordered = store
    .list()
    .sort((a, b) => compare(boundary(a), boundary(b)))
    .filter((project) => cursor === null || compare(boundary(project), cursor) > 0)
  const data = ordered.slice(0, limit),
    last = data.at(-1)
  return {
    data,
    nextCursor:
      ordered.length > limit && last
        ? Buffer.from(JSON.stringify({ scope, ...boundary(last) })).toString('base64url')
        : null,
  }
}

export function projectRequest(
  store: ProjectStore,
  method: string,
  params: Record<string, unknown>,
  changed: (projectId: string, changeType: 'created' | 'updated' | 'deleted') => void,
  assigned: (threadId: string, projectId: string | null) => void,
): unknown {
  if (method === 'project/list') return projectPage(store, params)
  if (method === 'project/create' || method === 'project/import') {
    const fields = {
      name: requiredString(params.name, 'name'),
      roots: roots(params.roots),
      metadata: params.metadata == null ? {} : metadata(params.metadata),
    }
    const ids = method === 'project/import' ? (params.threads ?? []) : []
    if (!Array.isArray(ids)) throw new ProtocolError(-32602, 'threads 必须是数组')
    const result = store.create(
      fields,
      requiredString(params.idempotencyKey, 'idempotencyKey'),
      ids.map((id) => requiredString(id, 'threads')),
    )
    if (result.created) changed(result.project.id, 'created')
    for (const threadId of result.assigned) assigned(threadId, result.project.id)
    return { project: result.project }
  }
  const id = requiredString(params.projectId, 'projectId')
  if (method === 'project/read') return { project: store.read(id) }
  if (method === 'project/update') {
    const patch: Partial<ProjectFields> = {}
    if (params.name != null) patch.name = requiredString(params.name, 'name')
    if (params.roots != null) patch.roots = roots(params.roots)
    if (params.metadata != null) patch.metadata = metadata(params.metadata)
    const project = store.update(id, patch)
    changed(id, 'updated')
    return { project }
  }
  if (method === 'project/move') {
    const before =
      params.beforeProjectId == null
        ? null
        : requiredString(params.beforeProjectId, 'beforeProjectId')
    if (store.move(id, before)) changed(id, 'updated')
    return {}
  }
  if (method === 'project/delete') {
    const members = store.delete(id)
    changed(id, 'deleted')
    for (const threadId of members) assigned(threadId, null)
    return {}
  }
  throw new ProtocolError(-32601, '未知项目方法')
}
