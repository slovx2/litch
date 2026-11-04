// 经理概览：上面一行控制台四类的未完成数（点了切到控制台对应页签），下面是经理维护的现状正文。
// 经理事项、时间线不在这里显示：事项有自己的页签，时间线界面上先不画（数据照旧随看板返回）。
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'

export type OverviewCategory = 'decisions' | 'requests' | 'reports' | 'suggestions'
export type OverviewCounts = Record<OverviewCategory, { pending: number; total: number }>

const CATEGORIES: readonly OverviewCategory[] = ['decisions', 'requests', 'reports', 'suggestions']

export function Overview({
  situation,
  counts,
  onOpen,
  refresh,
}: {
  situation: { text: string; at: number } | null
  counts: OverviewCounts
  onOpen(category: OverviewCategory): void
  /** 分页看板才有：重读摘要 */
  refresh?: { busy: boolean; run(): void }
}) {
  const t = useT()
  return (
    <section className="mg-overview" data-overview="root">
      <nav
        className="mg-overview-counts"
        aria-label={t('manager.inbox')}
        data-quiet={CATEGORIES.every((key) => !counts[key].pending) || undefined}
      >
        {CATEGORIES.map((key) => {
          const { pending, total } = counts[key]
          const detail = t('manager.overviewCount', { pending, total })
          return (
            <button
              type="button"
              key={key}
              data-overview-count={key}
              data-pending={pending > 0 || undefined}
              title={detail}
              aria-label={`${t(`manager.${key}`)} · ${detail}`}
              onClick={() => onOpen(key)}
            >
              <span className="mg-overview-label">{t(`manager.${key}`)}</span>
              <b className="mg-overview-num">{pending}</b>
            </button>
          )
        })}
      </nav>
      <article className="mg-situation" data-overview="situation">
        <header>
          <h3>{t('manager.situation')}</h3>
          {situation ? (
            <span className="mg-situation-at">
              {t('manager.situationAt')} <Stamp at={situation.at} />
            </span>
          ) : null}
          {refresh ? (
            <button
              type="button"
              className="ibtn"
              data-act="manager-overview-refresh"
              title={t('manager.paging.refresh')}
              aria-label={t('manager.paging.refresh')}
              aria-busy={refresh.busy}
              disabled={refresh.busy}
              onClick={refresh.run}
            >
              <Icon name="reload" small />
            </button>
          ) : null}
        </header>
        {situation?.text ? (
          <BoardMarkdown text={situation.text} />
        ) : (
          <p className="mg-situation-empty">{t('manager.situationEmpty')}</p>
        )}
      </article>
    </section>
  )
}
