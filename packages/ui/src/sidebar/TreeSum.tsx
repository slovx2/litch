// 父会话收起时子会话列表末尾的一行“› N 个子会话”（经理的工作线同样收在这里）。
// 设备目录、「最近 / 未读」、置顶与本地分组共用这一行，点一下展开父会话。
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'

export function TreeSum({
  kids,
  tucked,
  more = false,
  onUnfold,
}: {
  /** 一共有几个子会话：提示里写 */
  kids: number
  /** 收着没露出来的几个 */
  tucked: number
  /** 收起时已有子会话露出来（选中的、等人的、未读的）：写成“还有 N 个” */
  more?: boolean
  onUnfold(): void
}) {
  const t = useT()
  return (
    <button
      type="button"
      className="tree-sum"
      aria-expanded="false"
      title={t('tree.unfold', { n: kids })}
      onClick={onUnfold}
    >
      <Caret />
      <span className="ell">{t(more ? 'tree.tuckedMore' : 'tree.tucked', { n: tucked })}</span>
    </button>
  )
}
