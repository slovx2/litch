// 单击要等双击窗口结束再关闭；拖动、捏合、取消和卸载都撤掉尚未执行的单击。
export function imageTaps(single: () => void, double: () => void) {
  let pending: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
  }
  return {
    cancel,
    tap() {
      if (pending !== undefined) {
        cancel()
        double()
      } else {
        pending = setTimeout(() => {
          pending = undefined
          single()
        }, 300)
      }
    },
  }
}
