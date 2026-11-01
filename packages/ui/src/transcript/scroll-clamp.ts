/**
 * 反向列收起内容时，从浏览器夹限前的位置补偿。
 * scrollHeight/clientHeight 各自取整，差值可能比实际极限多 1px；用同一坐标系里的
 * 内容顶边和视口顶边判断是否已到顶，不能拿取整后的范围与亚像素 scrollTop 比较。
 */
export function scrollClampBase(
  seen: number | null,
  current: number,
  contentTop: number,
  viewportTop: number,
): number {
  return seen !== null && seen < current && Math.abs(contentTop - viewportTop) < 1 ? seen : current
}
