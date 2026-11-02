// 「最近」组快捷设置的纯逻辑：形状、可选条数和读文件时的校正。不引 react，单测直接用。
export interface RecentSettings {
  collapsed: boolean
  byProject: boolean
  first: number
}

export const FIRST_CHOICES = [5, 10, 20] as const
/** “显示更多”每次多几条（和桌面一样） */
export const MORE_STEP = 10

export function readRecentSettings(value: unknown): RecentSettings {
  const source = value && typeof value === 'object' ? (value as Partial<RecentSettings>) : {}
  const first = FIRST_CHOICES.find((n) => n === source.first) ?? FIRST_CHOICES[0]
  return { collapsed: source.collapsed === true, byProject: source.byProject === true, first }
}
