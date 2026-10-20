import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { ImportedCookie } from '../protected-types.mjs'
import { ReadFault } from './result.mjs'

export type Row = Record<string, SQLOutputValue>
export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
export function blob(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) throw new ReadFault('failed')
  return Buffer.from(value)
}
export function unixChrome(value: unknown): number | undefined {
  const number = Number(value)
  return number && Number.isFinite(number) ? number / 1_000_000 - 11_644_473_600 : undefined
}
export function time(value: unknown, divisor: number): number | undefined {
  const number = Number(value)
  return number && Number.isFinite(number) ? number / divisor : undefined
}
export function sameSite(value: unknown, firefox = false): ImportedCookie['sameSite'] {
  return Number(value) === 0
    ? firefox
      ? 'unspecified'
      : 'no_restriction'
    : Number(value) === 1
      ? 'lax'
      : Number(value) === 2
        ? 'strict'
        : 'unspecified'
}
export function origin(url: string): string {
  try {
    const value = new URL(url)
    return value.origin === 'null' ? url : value.origin
  } catch {
    return url
  }
}
export function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}
export function cookieFilter(domains?: string[]): (host: unknown) => boolean {
  if (!domains?.length) return () => true
  return (host) => {
    const value = text(host).replace(/^\./, '').toLowerCase()
    return domains.some((domain) => value === domain || value.endsWith(`.${domain}`))
  }
}
export function count(db: DatabaseSync, table: 'cookies' | 'moz_cookies' | 'logins'): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get()
  return Number(row?.n ?? 0)
}
export function* rows(
  db: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
): IterableIterator<Row> {
  const statement = db.prepare(sql)
  // Chromium 微秒时间超过 MAX_SAFE_INTEGER；node:sqlite 默认会拒绝整条记录。
  // 先接 bigint 再换数值，接口最后交 Unix 秒，微秒精度由 number 的表示范围决定。
  statement.setReadBigInts(true)
  for (const row of statement.iterate(...args)) {
    for (const [key, value] of Object.entries(row))
      if (typeof value === 'bigint') row[key] = Number(value)
    yield row
  }
}
