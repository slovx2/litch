// 侧栏一组会话的分页：先露出前几个，“显示更多”每次多露一批。设备树的项目和置顶区里的项目共用。

/** 一个工作区里先露出几个会话 */
export const FIRST_ROWS = 5
/** 点一次“显示更多”多露出几个 */
export const MORE_ROWS = 10

export interface Page {
  /** 这一页画出来的（按原顺序） */
  visible: string[]
  /** 收在“显示更多”后面的个数 */
  hidden: number
  /** 点过“显示更多”、而且收得回去：出“收起” */
  shrinkable: boolean
}

/**
 * list 是一组里的顶层会话（子会话跟着父会话画，不在这里）；more 是点“显示更多”多出来的个数；
 * keep 为真的（选中的、等人的、未读的）超出这一页也照样露出来。只剩一个没露出来时不值得多一个按钮，全部露出
 */
export function pageRows(
  list: readonly string[],
  more: number,
  first: number = FIRST_ROWS,
  keep: (id: string) => boolean = () => false,
): Page {
  let limit = first + more
  if (list.length - limit <= 1) limit = list.length
  const visible = list.filter((id, index) => index < limit || keep(id))
  return {
    visible,
    hidden: list.length - visible.length,
    shrinkable: more > 0 && list.length > first + 1,
  }
}

/** 定位到排在 index 的那一行（从 0 数）至少要多露出几个；不用多露时是 0 */
export function moreToReveal(index: number, first: number = FIRST_ROWS): number {
  return Math.max(0, index + 1 - first)
}
