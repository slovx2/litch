// 插话交付状态。sent 只表示原生运行时接纳，不表示模型已经理解或执行。
export type InputDelivery = 'queued' | 'sent' | 'held' | 'unknown'

export function inputDelivery(item: unknown): InputDelivery | undefined {
  const value = (item as { litchInputDelivery?: unknown } | null)?.litchInputDelivery
  return value === 'queued' || value === 'sent' || value === 'held' || value === 'unknown'
    ? value
    : undefined
}
