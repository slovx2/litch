import { ProtocolError, requiredString } from './protocol-contract.mjs'

export type CatalogCursor = { value: number; id: string; inclusive: boolean }

export function catalogPagination(
  params: Record<string, unknown>,
  scope: string,
): {
  limit: number
  sortDirection: 'asc' | 'desc'
  cursor: CatalogCursor | null
  encode: (value: number, id: string, inclusive?: boolean) => string
} {
  const limit = params.limit ?? 50
  const sortDirection = params.sortDirection ?? 'desc'
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ProtocolError(-32602, 'limit 必须在 1 到 1000 之间')
  if (sortDirection !== 'asc' && sortDirection !== 'desc')
    throw new ProtocolError(-32602, 'sortDirection 无效')
  let cursor: CatalogCursor | null = null
  if (params.cursor != null) {
    try {
      const value = JSON.parse(
        Buffer.from(requiredString(params.cursor, 'cursor'), 'base64url').toString(),
      )
      if (
        value.scope !== scope ||
        !Number.isFinite(value.value) ||
        typeof value.inclusive !== 'boolean'
      )
        throw new Error('游标范围无效')
      cursor = {
        value: value.value,
        id: requiredString(value.id, 'cursor.id'),
        inclusive: value.inclusive,
      }
    } catch {
      throw new ProtocolError(-32602, '会话游标无效或不属于本次查询')
    }
  }
  const encode = (value: number, id: string, inclusive = false) =>
    Buffer.from(JSON.stringify({ scope, value, id, inclusive })).toString('base64url')
  return { limit, sortDirection, cursor, encode }
}
