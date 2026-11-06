/** 同意框先收起输入键盘；收起过程中的返回只处理键盘，不等同于拒绝数据许可。 */
export function consentKeyboard({
  visible,
  dismiss,
  cancel,
}: {
  visible(): boolean
  dismiss(): Promise<void>
  cancel(): void
}) {
  let hiding: Promise<void> | null = null
  const hide = () => {
    if (hiding) return hiding
    hiding = dismiss().finally(() => {
      hiding = null
    })
    return hiding
  }
  return {
    hide,
    back() {
      if (hiding || visible()) return hide()
      cancel()
      return Promise.resolve()
    },
  }
}
