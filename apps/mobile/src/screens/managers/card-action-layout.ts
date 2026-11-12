/** 在卡片边界内将卡尾向上移到可用视口底部；原位置保留完整高度。 */
export function cardActionOffset(
  cardTop: number,
  footerTop: number,
  footerHeight: number,
  viewportBottom: number,
): number {
  'worklet'
  return Math.max(cardTop - footerTop, Math.min(0, viewportBottom - footerTop - footerHeight))
}
