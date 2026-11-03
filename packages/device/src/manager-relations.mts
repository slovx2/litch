// 显式关系只存一条边；双向显示与旧字段关系均按读取时投影。
import type { ManagerRelation, ManagerRelationTarget } from '../../protocol/src/manager-posts.mjs'
import type { ManagerStore } from './manager-store.mjs'
import { managerNow } from './manager-store.mjs'
import { fields, invalid, text } from './manager-validate.mjs'
export function addRelations(
  store: ManagerStore,
  managerId: string,
  id: string,
  args: Record<string, unknown>,
  belongs: (threadId: string) => boolean,
  suggestionBelongs: (id: string) => boolean = () => false,
) {
  const self: ManagerRelationTarget = { kind: id.startsWith('I-') ? 'item' : 'issue', target: id }
  const pending: ManagerRelation[] = []
  for (const [field, kind] of [
    ['source', 'derived'],
    ['related', 'related'],
  ] as const) {
    const entries = args[field] ?? []
    if (!Array.isArray(entries)) invalid(`${field} must be an array.`)
    for (const given of entries) {
      const target = fields(given) as unknown as ManagerRelationTarget
      text(target.target, 'target')
      if (target.kind === 'item' || target.kind === 'issue') {
        const object =
          store.object(managerId, target.target) ??
          store.publishedReports(managerId).find((r) => r.id === target.target) ??
          (target.target.startsWith('S-') && suggestionBelongs(target.target.slice(2))
            ? { id: target.target }
            : null)
        if (!object || (target.kind === 'item') !== target.target.startsWith('I-'))
          invalid('Related objects must belong to this manager.')
      } else if (target.kind === 'thread') {
        if (!belongs(target.target) && store.manager(managerId)?.threadId !== target.target)
          invalid('Related worklines must belong to this manager.')
      } else if (!['file', 'branch', 'commit', 'url'].includes(target.kind))
        invalid('Unknown relation target.')
      if (target.kind === self.kind && target.target === id)
        invalid('An object cannot link to itself.')
      const key = JSON.stringify([self.kind, id, kind, target.kind, target.target])
      pending.push({ id: key, from: self, to: target, kind, at: managerNow(), by: 'manager' })
    }
  }
  for (const relation of pending) store.saveRelation(managerId, relation)
  if (pending.length)
    store.record(
      managerId,
      id as import('../../protocol/src/manager.mjs').ManagerObjectId,
      'manager',
      null,
      { relations: pending },
      typeof args.why === 'string' ? args.why : 'Links added',
    )
  return pending
}
export function projectedRelations(store: ManagerStore, managerId: string): ManagerRelation[] {
  const result = store.relations(managerId)
  const add = (from: ManagerRelationTarget, to: ManagerRelationTarget) => {
    result.push({
      id: JSON.stringify(['projection', from, to]),
      from,
      to,
      kind: 'related',
      at: 0,
      by: 'projection',
    })
  }
  for (const obj of store.objects(managerId)) {
    const from: ManagerRelationTarget = {
      kind: obj.id.startsWith('I-') ? 'item' : 'issue',
      target: obj.id,
    }
    for (const link of [...obj.basis, ...obj.links])
      add(from, {
        kind: link.kind,
        target: link.target,
        ...(link.label ? { label: link.label } : {}),
      })
    if ('blocks' in obj) for (const id of obj.blocks) add(from, { kind: 'item', target: id })
    if ('blockedBy' in obj) for (const id of obj.blockedBy) add(from, { kind: 'issue', target: id })
    if ('owner' in obj && obj.owner.kind === 'line')
      add(from, { kind: 'thread', target: obj.owner.threadId })
  }
  return result
}

/** 首屏和工作线入口只需要会话关联；SQLite 提取这些小字段，不读取对象正文。 */
export function projectedLineRelations(store: ManagerStore, managerId: string): ManagerRelation[] {
  const result = store
    .relations(managerId)
    .filter((edge) => edge.from.kind === 'thread' || edge.to.kind === 'thread')
  const rows = store.db
    .prepare(`SELECT id,json_extract(body,'$.basis') AS basis,
    json_extract(body,'$.links') AS links,json_extract(body,'$.owner') AS owner
    FROM objects WHERE manager_id=?`)
    .all(managerId)
  for (const row of rows) {
    const id = String(row.id)
    const from: ManagerRelationTarget = { kind: id.startsWith('I-') ? 'item' : 'issue', target: id }
    const add = (to: ManagerRelationTarget) =>
      result.push({
        id: JSON.stringify(['projection', from, to]),
        from,
        to,
        kind: 'related',
        at: 0,
        by: 'projection',
      })
    for (const field of ['basis', 'links']) {
      const links = JSON.parse(String(row[field] ?? '[]')) as {
        kind: string
        target: string
        label?: string
      }[]
      for (const link of links)
        if (link.kind === 'thread')
          add({ kind: 'thread', target: link.target, ...(link.label ? { label: link.label } : {}) })
    }
    const owner = JSON.parse(String(row.owner ?? 'null')) as {
      kind: string
      threadId?: string
    } | null
    if (owner?.kind === 'line' && owner.threadId) add({ kind: 'thread', target: owner.threadId })
  }
  return result
}
