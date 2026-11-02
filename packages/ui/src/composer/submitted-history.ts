// 只记录输入框的提交原文。协议中的 userMessage 还包含系统注入和展开文本，不能作为来源证明。
export function createSubmittedHistory(storage: { read(): unknown; write(value: unknown): void }) {
  let entries: Map<string, string[]> | undefined
  const all = () => {
    if (entries) return entries
    entries = new Map()
    try {
      const raw = storage.read()
      if (Array.isArray(raw)) {
        for (const pair of raw) {
          if (Array.isArray(pair) && typeof pair[0] === 'string' && Array.isArray(pair[1]))
            entries.set(
              pair[0],
              pair[1]
                .filter((word): word is string => typeof word === 'string' && !!word.trim())
                .slice(-100),
            )
        }
      }
    } catch {
      // 本地存储不可用时，本次窗口内仍可回忆。
    }
    return entries
  }
  return {
    read: (key: string): string[] => [...(all().get(key) ?? [])],
    add(key: string, text: string) {
      if (!text.trim()) return
      const saved = all()
      const words = [...(saved.get(key) ?? []).filter((word) => word !== text), text].slice(-100)
      saved.delete(key)
      saved.set(key, words)
      while (saved.size > 200) saved.delete(saved.keys().next().value as string)
      try {
        storage.write([...saved])
      } catch {
        // 配额不足不影响发送和内存中的原文。
      }
    },
  }
}

const history = createSubmittedHistory({
  read: () => JSON.parse(localStorage.getItem('litch.submittedHistory') ?? 'null'),
  write: (value) => localStorage.setItem('litch.submittedHistory', JSON.stringify(value)),
})

export const submittedHistory = history.read
export const rememberSubmitted = history.add
