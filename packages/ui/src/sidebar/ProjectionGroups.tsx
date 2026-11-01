import {
  keys,
  pageSidebarProjection,
  type SidebarProjectionBlock,
  type SidebarProjectionKind,
  type SidebarProjections,
} from '@litch/core'
import { type ReactNode, useMemo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'
import { useKey, useKeys } from '../app/services.tsx'
import { setProjectionSettings, useProjectionSettings } from './projection-state.ts'
import { RowMenu } from './RowMenu.tsx'

const NONE: string[] = []
export interface ProjectedBlock {
  kind: SidebarProjectionKind
  block: SidebarProjectionBlock
  byProject: boolean
}
export function ProjectionGroups({ render }: { render(props: ProjectedBlock): ReactNode }) {
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const projections = useKeys<SidebarProjections>(devices.map(keys.sidebarProjections))
  return (
    <>
      <ProjectionGroup kind="unread" projections={projections} render={render} />
      <ProjectionGroup kind="recent" projections={projections} render={render} />
    </>
  )
}

function ProjectionGroup({
  kind,
  projections,
  render,
}: {
  kind: SidebarProjectionKind
  projections: readonly (SidebarProjections | undefined)[]
  render(props: ProjectedBlock): ReactNode
}) {
  const t = useT()
  const settings = useProjectionSettings(kind)
  const [extra, setExtra] = useState(0)
  const rows = useMemo(
    () => projections.flatMap((value) => value?.[kind] ?? []),
    [projections, kind],
  )
  const page = useMemo(
    () => pageSidebarProjection(rows, settings.byProject, settings.first + extra),
    [rows, settings.byProject, settings.first, extra],
  )
  return (
    <section className="projection-group" data-projection={kind}>
      <div className="row-line projection-head">
        <button
          type="button"
          className="dev-row"
          aria-expanded={!settings.collapsed}
          onClick={() => setProjectionSettings(kind, { collapsed: !settings.collapsed })}
        >
          <span className={settings.collapsed ? 'arr shut' : 'arr'}>
            <Caret />
          </span>
          <span className="name ell">{t(`sidebar.projection.${kind}`)}</span>
          <span className="grow" />
          <span className="dim projection-count">{rows.length}</span>
        </button>
        <RowMenu
          label={t('sidebar.projection.settings', { name: t(`sidebar.projection.${kind}`) })}
          actions={[
            {
              id: 'project',
              title: t(
                settings.byProject ? 'sidebar.projection.flat' : 'sidebar.projection.project',
              ),
            },
            {
              id: 'first',
              title: t('sidebar.projection.first', { n: settings.first }),
              choices: {
                title: t('sidebar.projection.firstTitle'),
                back: t('session.move.back'),
                options: [5, 10, 20].map((n) => ({ id: String(n), title: String(n) })),
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
            <div key={block.key}>{render({ kind, block, byProject: settings.byProject })}</div>
          ))}
          {rows.length === 0 ? (
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
