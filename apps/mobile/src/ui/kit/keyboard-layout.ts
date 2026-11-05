/** 焦点下方留出一行操作；容器自身已经避让时，只补容器与键盘之间的距离，不再加一份键盘高度。 */
export function keyboardFormLayout({
  keyboardHeight,
  windowHeight,
  viewportBottom,
  viewportTop = null,
  actionHeight,
  contained,
  accessoryHeight = 0,
  inputHeight = 80,
}: {
  keyboardHeight: number
  windowHeight: number
  viewportBottom: number | null
  viewportTop?: number | null
  actionHeight: number
  contained: boolean
  accessoryHeight?: number
  inputHeight?: number
}) {
  const keyboard = Math.max(0, keyboardHeight)
  const gap =
    keyboard > 0 && viewportBottom !== null
      ? Math.max(0, windowHeight - keyboard - viewportBottom)
      : 0
  const accessory = keyboard > 0 ? Math.max(0, accessoryHeight) : 0
  const available =
    keyboard > 0 && viewportTop !== null && viewportBottom !== null
      ? Math.max(0, Math.min(viewportBottom, windowHeight - keyboard - accessory) - viewportTop)
      : null
  // 首次聚焦时按整个输入框留位置；选区就绪后按光标落点留位置，与滚动库保持一致，
  // 不能为按钮预留空间而把首行推到标题后面。短视口的提交由区域底部操作条承接。
  const desired = Math.max(0, actionHeight) + 16
  const reserve =
    available === null
      ? desired
      : Math.min(desired, Math.max(0, available - Math.max(44, inputHeight)))
  return {
    bottomOffset: reserve + Math.max(gap, accessory),
    extraKeyboardSpace: contained ? (keyboard > 0 ? -keyboard : 0) : Math.max(0, accessoryHeight),
  }
}
