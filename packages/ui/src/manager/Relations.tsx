import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ManagerBoardView, ManagerView } from '../../../core/src/model-manager.mts'
import type { ManagerRelationTarget } from '../../../protocol/src/manager-posts.mjs'
import { relationGroups } from '../../../protocol/src/manager-relations.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { openInFiles } from '../files/state.ts'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { BoardReferencesContext } from './BoardReferences.tsx'
import { useManagerFeatures } from './data.ts'
import type { BoardReference } from './references.ts'

const RELATION_ICONS = {
  issue: '○',
  item: '▤',
  thread: '↗',
  file: '▱',
  branch: '⑂',
  commit: '◇',
  url: '↗',
} as const
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
  const navigation = useContext(BoardReferencesContext)
  const t = useT()
  // 提交、差异之类要向设备读原文（reference/read，属于 Posts）：比应用旧的设备服务读不了
  const features = useManagerFeatures()
  const unreadable = (target: ManagerRelationTarget) =>
    !features.posts && !['issue', 'item', 'thread', 'url', 'file'].includes(target.kind)
  const { channel } = useServices()
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [wide, setWide] = useState(false)
  const root = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!context || !id) return
    const parent = root.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => setWide(parent.clientWidth >= 520))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [context, id])
  if (!context) return null
  const { manager, board } = context
  const groups = relationGroups(board.relations ?? [], { kind, target: id })
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
  const open = async (target: ManagerRelationTarget) => {
    if (target.kind === 'issue' || target.kind === 'item') {
      navigation?.open(target.target as BoardReference)
      return
    }
    if (target.kind === 'thread') {
      requestOpenSession({ deviceId: manager.deviceId, sessionId: target.target })
      return
    }
    if (target.kind === 'url') {
      if (/^https?:\/\//.test(target.target))
        window.open(target.target, '_blank', 'noopener,noreferrer')
      return
    }
    if (target.kind === 'file') {
      openInFiles({
        deviceId: manager.deviceId,
        workspaceId: null,
        root: manager.cwd,
        path: /^(\/|[A-Za-z]:[\\/])/.test(target.target)
          ? target.target
          : `${manager.cwd}/${target.target}`,
      })
      return
    }
    try {
      const result = await channel.command('managers.reference.read', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        reference: target.target,
      })
      setPreview(result.text)
      setError('')
    } catch (e) {
      setError(reasonOf(e, t))
    }
  }
  return (
    <details
      ref={root}
      className={reverse ? 'mg-related-issues' : 'mg-relations'}
      open={wide}
      data-wide={wide}
      data-relations={id}
    >
      <summary>
        {t(reverse ? 'manager.relatedIssues' : 'manager.relations')} {all.length}
      </summary>
      {entries.map(([group, targets]) =>
        targets.length ? (
          <section key={group}>
            <b>{t(`manager.relation.${group}`)}</b>
            <div>
              {targets.map((target) => (
                <button
                  type="button"
                  className="btn ghost"
                  key={`${target.kind}:${target.target}`}
                  title={unreadable(target) ? t('manager.oldDeviceShort') : title(target)}
                  disabled={unreadable(target)}
                  data-relation-target={target.target}
                  onClick={() => void open(target)}
                >
                  <span className="mg-relation-kind">
                    <span aria-hidden="true">{RELATION_ICONS[target.kind]}</span>{' '}
                    {t(`manager.relationKind.${target.kind}`)}
                  </span>
                  {/^[DIRP]-\d+$/.test(target.target) &&
                  (target.kind === 'issue' || target.kind === 'item')
                    ? `#${target.target} · `
                    : ''}
                  {title(target)}
                </button>
              ))}
            </div>
          </section>
        ) : null,
      )}
      {preview !== null ? (
        <dialog open className="mg-reference-preview">
          <button type="button" className="btn" onClick={() => setPreview(null)}>
            {t('manager.close')}
          </button>
          <BoardMarkdown text={`\`\`\`diff\n${preview}\n\`\`\``} />
        </dialog>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  )
}
