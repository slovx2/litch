import {
  keys,
  pageSidebarProjection,
  retainOpenedUnread,
  type SessionChildren,
  type SidebarProjectionBlock,
  type SidebarProjectionKind,
  type SidebarProjections,
} from '@litch/core'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'
import { useKey, useKeys } from '../app/services.tsx'
import { setProjectionSettings, useProjectionSettings } from './projection-state.ts'
import { RowMenu } from './RowMenu.tsx'
import { useSidebarReveal } from './reveal-context.ts'
import { projectionRoot, rememberUnread, type UnreadMemory } from './selection.ts'

const NONE: string[] = []
export interface ProjectedBlock {
  kind: SidebarProjectionKind
  block: SidebarProjectionBlock
  byProject: boolean
  showDevice: boolean
}
export function ProjectionGroups({
  render,
  selection,
}: {
  render(props: ProjectedBlock): ReactNode
  selection: Selection | null
}) {
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const projections = useKeys<SidebarProjections>(devices.map(keys.sidebarProjections))
  const children = useKey<SessionChildren>(keys.children(selection?.deviceId ?? ''))
  // 原生子会话和 Litch 子会话都归到同一个主项，切换同棵子树时保留它。
  const selectedRoot = useMemo(
    () => projectionRoot(selection, children ?? {}),
    [selection, children],
  )
  return (
    <>
      <ProjectionGroup
        kind="unread"
        projections={projections}
        render={render}
        selection={selectedRoot}
      />
      <ProjectionGroup kind="recent" projections={projections} render={render} selection={null} />
    </>
  )
}

function ProjectionGroup({
  kind,
  projections,
  render,
  selection,
}: {
  kind: SidebarProjectionKind
  projections: readonly (SidebarProjections | undefined)[]
  render(props: ProjectedBlock): ReactNode
  selection: Selection | null
}) {
  const t = useT()
  const headingId = useId()
  const settings = useProjectionSettings(kind)
  const [extra, setExtra] = useState(0)
  const rows = useMemo(
    () =>
      retainOpenedUnread(
        projections.flatMap((value) => value?.[kind] ?? []),
        null,
      ),
    [projections, kind],
  )
  const { selected: selectedRow, checkProjection } = useSidebarReveal()
  const selectedProjection = useKey<SidebarProjections>(
    keys.sidebarProjections(selectedRow?.deviceId ?? ''),
  )
  const selectedChildren = useKey<SessionChildren>(keys.children(selectedRow?.deviceId ?? ''))
  const [held, setHeld] = useState<UnreadMemory>({
    root: null,
    opened: null,
  })
  const next = rememberUnread(held, selection, rows)
  // 在提交画面前固定原位置，避免读标记的下一帧把下一项顶到鼠标下。
  if (next !== held) setHeld(next)
  const opened = next.opened
  const shownRows = useMemo(() => retainOpenedUnread(rows, opened), [rows, opened])
  useEffect(() => {
    // 快照尚未到达不等于投影移除了会话；按完整列表判断，折叠或分页不会挪动选择。
    if (selectedProjection && selectedChildren) checkProjection(kind, shownRows, selectedChildren)
  }, [kind, shownRows, selectedProjection, selectedChildren, checkProjection])
  const page = useMemo(
    () => pageSidebarProjection(rows, settings.byProject, settings.first + extra, opened),
    [rows, settings.byProject, settings.first, extra, opened],
  )
  const showDevice = new Set(page.blocks.map((block) => block.deviceId)).size > 1
  return (
    <section className="projection-group" data-projection={kind} aria-labelledby={headingId}>
      <div className="row-line projection-head">
        <button
          type="button"
          className="dev-row"
          aria-label={
            kind === 'unread' ? t('sidebar.projection.count', { n: rows.length }) : undefined
          }
          aria-expanded={!settings.collapsed}
          onClick={() => setProjectionSettings(kind, { collapsed: !settings.collapsed })}
        >
          <span className={settings.collapsed ? 'arr wire-sq shut' : 'arr wire-sq'}>
            <Caret />
          </span>
          <span className="name ell" id={headingId}>
            {t(`sidebar.projection.${kind}`)}
          </span>
          <span className="grow" />
          {kind === 'unread' ? (
            <span className="dim projection-count" aria-hidden="true">
              {rows.length}
            </span>
          ) : null}
        </button>
        <RowMenu
          label={t('sidebar.projection.settings', { name: t(`sidebar.projection.${kind}`) })}
          actions={[
            {
              id: 'project',
              title: t('sidebar.projection.project'),
              checked: settings.byProject,
            },
            {
              id: 'first',
              title: t('sidebar.projection.first', { n: settings.first }),
              choices: {
                title: t('sidebar.projection.firstTitle'),
                back: t('session.move.back'),
                options: [5, 10, 20].map((n) => ({
                  id: String(n),
                  title: String(n),
                  checked: settings.first === n,
                })),
              },
            },
          ]}
          onAction={(id, choice) => {
            if (id === 'project') setProjectionSettings(kind, { byProject: !settings.byProject })
            else if (choice) {
              setProjectionSettings(kind, { first: Number(choice) })
              setExtra(0)
            }
          }}
        />
      </div>
      {!settings.collapsed ? (
        <div className="projection-body">
          {page.blocks.map((block) => (
            <div key={block.key}>
              {render({ kind, block, byProject: settings.byProject, showDevice })}
            </div>
          ))}
          {shownRows.length === 0 ? (
            <div className="projection-empty dim">{t(`sidebar.projection.${kind}Empty`)}</div>
          ) : null}
          {page.remaining > 0 || extra > 0 ? (
            <div className="ss-more">
              {page.remaining > 0 ? (
                <>
                  <button
                    type="button"
                    className="mini more"
                    onClick={() => setExtra((was) => was + 10)}
                  >
                    {t('sidebar.showMore')}
                  </button>
                  <span className="dim grow">
                    {t('sidebar.hiddenCount', { count: page.remaining })}
                  </span>
                </>
              ) : null}
              {extra > 0 ? (
                <button type="button" className="mini" onClick={() => setExtra(0)}>
                  {t('sidebar.showLess')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
