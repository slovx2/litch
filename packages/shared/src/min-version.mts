// 运行时依赖只设下限：接受不低于锁定版本的稳定版，拒绝预发布与非法格式。
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

export function isVersionAtLeast(actual: string | undefined, minimum: string): boolean {
  const a = STABLE.exec(actual ?? '')
  const m = STABLE.exec(minimum)
  if (!a || !m) return false
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(m[i])
    if (diff !== 0) return diff > 0
  }
  return true
}
