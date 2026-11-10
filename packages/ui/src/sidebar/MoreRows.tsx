// 一组会话末尾那一行：“显示更多 · 还有 N 个”和“收起”。设备树的项目和置顶区里的项目共用（分页的判断在 paging.ts）
import { useT } from '../app/appearance.ts'
import type { Page } from './paging.ts'

export function MoreRows({ page, onMore, onLess }: { page: Page; onMore(): void; onLess(): void }) {
  const t = useT()
  if (page.hidden === 0 && !page.shrinkable) return null
  return (
    <div className="ss-more">
      {page.hidden > 0 ? (
        <>
          <button type="button" className="mini more" onClick={onMore}>
            {t('sidebar.showMore')}
          </button>
          <span className="dim grow">{t('sidebar.hiddenCount', { count: page.hidden })}</span>
        </>
      ) : (
        <span className="grow" />
      )}
      {page.shrinkable ? (
        <button type="button" className="mini less" onClick={onLess}>
          {t('sidebar.showLess')}
        </button>
      ) : null}
    </div>
  )
}
