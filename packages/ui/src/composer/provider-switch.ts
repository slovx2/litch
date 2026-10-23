// 会话中途换供应商：型号 ID 写成 `<供应商>/<型号>` 的 harness（Claude Code 多供应商、OpenCode、Pi），
// 下一轮要用的型号和上一轮的不是同一家时，输入框下面提示一行。只用可擦除的语法（test 直接引这个文件）。

/** 型号 ID 里的供应商；不带 `/` 的没有 */
export function providerOf(id: string | null): string | null {
  if (!id) return null
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : null
}

/**
 * 从 `ranWith`（上一轮用的型号）换到 `next` 是不是换了供应商；换了给出新的那家叫什么：
 * 选单里那一行显示名开头的 `[名字]`，没有就用 ID 里的前缀
 */
export function switchedProvider(
  ranWith: string | null,
  next: string | null,
  models: readonly { id: string; title: string }[],
): string | null {
  const before = providerOf(ranWith)
  const after = providerOf(next)
  if (!before || !after || before === after) return null
  const title = models.find((model) => model.id === next)?.title ?? ''
  return /^\[([^\]]+)\]/.exec(title)?.[1] ?? after
}
