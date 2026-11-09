import { createContext, useContext } from 'react'
import type { ManagerBoardView, ManagerView } from '../../../core/src/model-manager.mts'
import { managerRelationGroups } from '../../../core/src/projection/manager-relations.mts'
import type { ManagerRelationTarget } from '../../../protocol/src/manager-posts.mjs'
import { useT } from '../app/appearance.ts'
import { useManagerFeatures } from './data.ts'
import { RelationLink } from './RelationLink.tsx'

export const RelationsContext = createContext<{
  board: ManagerBoardView
  manager: ManagerView
} | null>(null)
export function Relations({
  id,
  kind = 'issue',
  reverse = false,
}: {
  id: string
  kind?: 'issue' | 'item' | 'thread'
  reverse?: boolean
}) {
  const context = useContext(RelationsContext)
  const t = useT()
  // 提交、差异之类要向设备读原文（reference/read，属于 Posts）：比应用旧的设备服务读不了
  const features = useManagerFeatures()
  const unreadable = (target: ManagerRelationTarget) =>
    !features.posts && !['issue', 'item', 'thread', 'url', 'file'].includes(target.kind)
  if (!context) return null
  const { manager, board } = context
  const groups = managerRelationGroups(board, { kind, target: id })
  const entries = Object.entries(groups) as [keyof typeof groups, ManagerRelationTarget[]][]
  const all = entries.flatMap(([, targets]) => targets)
  if (!all.length) return null
  const title = (target: ManagerRelationTarget) => {
    if (target.kind === 'issue')
      return (
        board.posts?.find((p) => p.id === target.target)?.title ??
        target.label ??
        t('manager.issue')
      )
    if (target.kind === 'item')
      return board.items.find((i) => i.id === target.target)?.title ?? target.label ?? target.target
    if (target.kind === 'thread')
      return (
        board.lines.find((l) => l.threadId === target.target)?.title ??
        target.label ??
        t('manager.source.line')
      )
    return target.label ?? target.target
  }
  return (
    <details
      className={reverse ? 'mg-related-issues' : 'mg-relations'}
      key={`${kind}:${id}`}
      data-relations={id}
    >
      <summary>
        {t(reverse ? 'manager.relatedIssues' : 'manager.relations')} {all.length}
      </summary>
      {entries.map(([group, targets]) =>
        targets.length ? (
          <section key={group}>
            {/* 只有一种关系时不写分组名：上面的“关联 N”已经说了 */}
            {entries.filter(([, list]) => list.length).length > 1 ? (
              <b>{t(`manager.relation.${group}`)}</b>
            ) : null}
            <div>
              {targets.map((target) => (
                <RelationLink
                  key={`${target.kind}:${target.target}`}
                  target={target}
                  manager={manager}
                  label={title(target)}
                  disabled={unreadable(target)}
                />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </details>
  )
}
