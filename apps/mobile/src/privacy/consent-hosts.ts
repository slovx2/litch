// 同意框由最上层已打开的弹窗或讨论抽屉承载；没有承载点时回到页面根节点。
export function createConsentHosts() {
  let entries: { id: string }[] = []
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }
  return {
    current: () => entries.at(-1)?.id ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register(id: string) {
      const entry = { id }
      entries = [...entries, entry]
      changed()
      return () => {
        entries = entries.filter((value) => value !== entry)
        changed()
      }
    },
  }
}
