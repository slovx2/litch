// 设备详情里能收起的一节：标题行是一个带箭头的按钮，后面跟一句摘要；点开才是里面的内容。
// 详情页一打开只露一眼要看的，SSH 入口、设备级的各组设置都收着，摘要里说得出大概就不用点开。
import { type ReactNode, useId } from 'react'
import { useT } from '../../app/appearance.ts'
import { Fold, useFold } from '../../app/Fold.tsx'

interface FoldSectionProps {
  title: string
  /** 标题后面的一句摘要。收着的时候靠它知道里面大概是什么状况 */
  summary?: ReactNode
  /** 里面有不能藏起来的东西：一定开着 */
  forced: boolean
  /** 这一节是什么，给验收和样式认 */
  sec: string
  group?: string | undefined
  children: ReactNode
}

export function FoldSection({ title, summary, forced, sec, group, children }: FoldSectionProps) {
  const t = useT()
  const fold = useFold(forced)
  const id = useId()
  return (
    <section className="mng-sec" data-sec={sec} data-group={group} data-open={fold.open}>
      <div className="mng-sec-head">
        <h2>
          <Fold
            open={fold.open}
            onToggle={fold.toggle}
            controls={id}
            title={forced ? t('manage.fold.locked') : undefined}
          >
            {title}
          </Fold>
        </h2>
        {summary}
      </div>
      {fold.open ? (
        <div id={id} className="mng-sec-body">
          {children}
        </div>
      ) : null}
    </section>
  )
}
