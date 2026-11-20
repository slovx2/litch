// 检查点只含采集状态。公开事件已按协议使用秒，无需再转换。
const instant = new Set([
  'at',
  'attemptedAt',
  'before',
  'checkedAt',
  'closedAt',
  'coveredThrough',
  'createdAt',
  'discoveredAt',
  'expiresAt',
  'from',
  'mergedAt',
  'nextPollAt',
  'observedAt',
  'repairAt',
  'retryAt',
  'to',
  'updatedAt',
])
const subjectNumber = new Set(['number', 'pullNumber', 'subjectNumber'])

// 检查点保留秒的小数部分。重启后须能重建首次读取时的正文版本键和精确重试时间。
function convert(value: unknown, saving: boolean, field = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => convert(item, saving))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, convert(item, saving, key)]),
    )
  }
  if (instant.has(field) && typeof value === 'number')
    return saving ? value / 1000 : Math.round(value * 1000)
  if (subjectNumber.has(field)) {
    if (saving && typeof value === 'number') return String(value)
    if (!saving && typeof value === 'string') return Number(value)
  }
  return value
}

export function encodeCheckpoint(value: object): object {
  return convert(value, true) as object
}

export function decodeCheckpoint<T extends object>(value: object | null): T | undefined {
  return value ? (convert(value, false) as T) : undefined
}
