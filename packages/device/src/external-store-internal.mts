import { createHash } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'

export const encode = (value: unknown): string => JSON.stringify(value)
type Row = Record<string, unknown>
export function decode<T>(row: Row): T
export function decode<T>(row: Row | undefined): T | null
export function decode<T>(row: Row | undefined): T | null {
  return row ? (JSON.parse(String(row.body)) as T) : null
}
export function numbered<T extends { seq: number }>(row: Row): T
export function numbered<T extends { seq: number }>(row: Row | undefined): T | null
export function numbered<T extends { seq: number }>(row: Row | undefined): T | null {
  return row ? { ...decode<T>(row), seq: Number(row.seq) } : null
}

export function requireRow<T>(row: T | null | undefined): T {
  if (row == null) throw new Error('外部来源账本缺少应有的记录')
  return row
}

export function signature(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => [key, visit(val)]),
    )
  }
  return createHash('sha256')
    .update(encode(visit(value)))
    .digest('hex')
}
export function requireExternalId(value: string): void {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new Error('外部 ID 必须是正十进制字符串')
}
export function boundedLimit(limit = 50): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('分页大小须为 1 到 100')
  return limit
}
export function where(terms: [string, SQLInputValue | undefined][]) {
  const present = terms.filter((term): term is [string, SQLInputValue] => term[1] !== undefined)
  return {
    sql: present.length ? `WHERE ${present.map(([clause]) => clause).join(' AND ')}` : '',
    bindings: present.map(([, value]) => value),
  }
}

export function page<T extends { seq: number }>(entries: T[], limit: number) {
  const extra = entries.length > limit
  if (extra) entries.pop()
  return { entries, nextBeforeSeq: extra ? (entries.at(-1)?.seq ?? null) : null }
}
