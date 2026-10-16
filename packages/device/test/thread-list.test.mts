import assert from 'node:assert/strict'
import test from 'node:test'
import { type ListSource, mergeThreadList, packCursor, unpackCursor } from '../src/thread-list.mjs'

interface Row {
  id: string
  updatedAt: number
}

/** 一个按更新时间倒序、用偏移量当游标的上游。rows 可以在两次取页之间被测试改掉 */
function source(harness: string, rows: Row[]) {
  const state = {
    harness,
    rows,
    calls: [] as Record<string, unknown>[],
    fail: null as string | null,
    async fetch(params: Record<string, unknown>) {
      state.calls.push(params)
      if (state.fail) throw new Error(state.fail)
      const sorted = [...state.rows].sort((a, b) => b.updatedAt - a.updatedAt)
      const start = typeof params.cursor === 'string' ? Number(params.cursor.slice(1)) : 0
      const limit = params.limit as number
      const data = sorted.slice(start, start + limit).map((row) => ({ ...row }))
      const end = start + data.length
      return { data, nextCursor: end < sorted.length ? `@${end}` : null }
    },
  }
  return state satisfies ListSource
}

const rows = (prefix: string, times: number[]): Row[] =>
  times.map((updatedAt, index) => ({ id: `${prefix}${index + 1}`, updatedAt }))

/** 一页一页翻到底，返回全部会话 */
async function drain(sources: ListSource[], limit: number, filters = {}) {
  const all: any[] = []
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const result = await mergeThreadList({ sources, limit, cursor, filters })
    assert.ok(result.data.length <= limit)
    all.push(...result.data)
    cursor = result.nextCursor
    if (cursor === null) return all
  }
  throw new Error('翻不到头')
}

test('游标：打包再解开是原样，乱写的被拒绝', () => {
  const cursor = {
    v: 1 as const,
    n: 20,
    s: { pi: { c: 'abc', a: 't9', t: 5 }, cc: { c: null }, d: null },
  }
  assert.deepEqual(unpackCursor(packCursor(cursor)), cursor)
  for (const bad of [
    'not-a-cursor',
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ v: 2, n: 1, s: {} })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, n: 0, s: {} })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, n: 5, s: { pi: { c: 7 } } })).toString('base64url'),
  ])
    assert.throws(() => unpackCursor(bad), /会话游标无效/)
})

test('合并：两路按更新时间倒序归并，打上 harness，上游收到的排序和筛选条件是对的', async () => {
  const a = source('a', rows('a', [90, 70, 50, 30, 10]))
  const b = source('b', rows('b', [80, 60, 40]))
  const result = await mergeThreadList({
    sources: [a, b],
    limit: 50,
    cursor: null,
    filters: { archived: false, cwd: '/work' },
  })
  assert.deepEqual(
    result.data.map((row) => `${row.id}@${row.harness}`),
    ['a1@a', 'b1@b', 'a2@a', 'b2@b', 'a3@a', 'b3@b', 'a4@a', 'a5@a'],
  )
  assert.equal(result.nextCursor, null)
  assert.deepEqual(result.failed, [])
  assert.deepEqual(a.calls[0], {
    archived: false,
    cwd: '/work',
    limit: 50,
    sortKey: 'updated_at',
    sortDirection: 'desc',
  })
})

test('翻页：每页大小各种取值，都是每个会话正好一次、整体有序', async () => {
  const a = rows('a', [100, 95, 94, 60, 59, 58, 57, 20, 5])
  const b = rows('b', [99, 98, 97, 96, 61, 30, 29])
  const c = rows('c', [50])
  const expected = [...a, ...b, ...c].sort((x, y) => y.updatedAt - x.updatedAt).map((row) => row.id)
  for (const limit of [1, 2, 3, 4, 5, 7, 16, 17, 50]) {
    const all = await drain(
      [source('a', a), source('b', b), source('c', c), source('d', [])],
      limit,
    )
    assert.deepEqual(
      all.map((row) => row.id),
      expected,
      `每页 ${limit} 个`,
    )
  }
})

test('翻页：停在一页中间时，下一次只重取那一页，不从头来', async () => {
  const a = source('a', rows('a', [90, 80, 70, 60]))
  const b = source('b', rows('b', [85, 5, 4, 3]))
  const first = await mergeThreadList({ sources: [a, b], limit: 3, cursor: null, filters: {} })
  assert.deepEqual(
    first.data.map((row) => row.id),
    ['a1', 'b1', 'a2'],
  )
  const packed = unpackCursor(first.nextCursor ?? '')
  // 向上游取页的大小记在游标里，一轮翻页里不变
  assert.equal(packed.n, 3)
  assert.deepEqual(packed.s.a, { c: null, a: 'a2', t: 80 })
  assert.deepEqual(packed.s.b, { c: null, a: 'b1', t: 85 })
  // 客户端中途改了每页大小：向上游取页仍然按原来的大小，位置才对得上
  const second = await mergeThreadList({
    sources: [a, b],
    limit: 10,
    cursor: first.nextCursor,
    filters: {},
  })
  assert.deepEqual(
    second.data.map((row) => row.id),
    ['a3', 'a4', 'b2', 'b3', 'b4'],
  )
  assert.equal(second.nextCursor, null)
  assert.ok(a.calls.every((call) => call.limit === 3))
})

test('翻页途中列表变了：不漏，停下的那个会话被删、被更新都接得上', async () => {
  // 每一段都配一个只有一条的上游 z，让第一页停在另一个上游那一页的中间（给出去的是它的第一条和 z1）
  const z = () => source('z', rows('z', [85]))
  const firstPage = async (sources: ListSource[]) => {
    const first = await mergeThreadList({ sources, limit: 2, cursor: null, filters: {} })
    assert.equal(first.data[1]?.id, 'z1')
    return first.nextCursor
  }
  const restOf = async (sources: ListSource[], cursor: string | null) => {
    const rest = await mergeThreadList({ sources, limit: 10, cursor, filters: {} })
    return rest.data.map((row) => row.id)
  }

  // 被删：按更新时间接
  const a = source('a', rows('a', [90, 80, 70, 60, 50]))
  let sources: ListSource[] = [a, z()]
  let cursor = await firstPage(sources)
  a.rows = a.rows.filter((row) => row.id !== 'a1')
  assert.deepEqual(await restOf(sources, cursor), ['a2', 'a3', 'a4', 'a5'])

  // 被更新：它排到了最前面。不能把它当成位置（那样后面的会漏），也不把它再给一遍
  const b = source('b', rows('b', [90, 80, 70, 60, 50]))
  sources = [b, z()]
  cursor = await firstPage(sources)
  b.rows = b.rows.map((row) => (row.id === 'b1' ? { ...row, updatedAt: 999 } : row))
  assert.deepEqual(await restOf(sources, cursor), ['b2', 'b3', 'b4', 'b5'])

  // 前面插进来很多新的：位置被挤到了后面的页里，要接着往后找
  const c = source('c', rows('c', [90, 80, 70, 60, 50]))
  sources = [c, z()]
  cursor = await firstPage(sources)
  c.rows = [...rows('n', [500, 400, 300, 200]), ...c.rows]
  assert.deepEqual(await restOf(sources, cursor), ['c2', 'c3', 'c4', 'c5'])
})

test('某一路出错：别的照常，出错的报出来并退出这一轮翻页；游标里没有的上游不参加', async () => {
  const a = source('a', rows('a', [90, 70, 50, 30]))
  const b = source('b', rows('b', [80, 60, 40]))
  b.fail = '上游挂了'
  const first = await mergeThreadList({ sources: [a, b], limit: 2, cursor: null, filters: {} })
  assert.deepEqual(
    first.data.map((row) => row.id),
    ['a1', 'a2'],
  )
  assert.deepEqual(first.failed, [{ harness: 'b', message: '上游挂了' }])
  assert.deepEqual(Object.keys(unpackCursor(first.nextCursor ?? '').s), ['a'])
  // b 后来好了，但这一轮翻页开始时没有它，接着翻也不把它从头混进来
  b.fail = null
  const second = await mergeThreadList({
    sources: [a, b],
    limit: 10,
    cursor: first.nextCursor,
    filters: {},
  })
  assert.deepEqual(
    second.data.map((row) => row.id),
    ['a3', 'a4'],
  )
  assert.deepEqual(second.excluded, ['b'])
  assert.equal(b.calls.length, 1)

  // 翻到一半才出错的：已经给出去的留着，后面不再有它
  const c = source('c', rows('c', [95, 94, 93, 92]))
  const d = source('d', rows('d', [10]))
  const begin = await mergeThreadList({ sources: [c, d], limit: 2, cursor: null, filters: {} })
  c.fail = '半路断了'
  const rest = await mergeThreadList({
    sources: [c, d],
    limit: 10,
    cursor: begin.nextCursor,
    filters: {},
  })
  assert.deepEqual(
    rest.data.map((row) => row.id),
    ['d1'],
  )
  assert.deepEqual(rest.failed, [{ harness: 'c', message: '半路断了' }])
  assert.equal(rest.nextCursor, null)

  // 一个上游都没有：空列表，不是错误
  const none = await mergeThreadList({ sources: [], limit: 10, cursor: null, filters: {} })
  assert.deepEqual(none, { data: [], nextCursor: null, failed: [], excluded: [] })
})

test('设备层自己的筛选：筛掉的不占位置，各种页大小都是每个留下的会话正好一次；不够一页就接着往上游要', async () => {
  const a = rows('a', [100, 95, 94, 60, 59, 58, 57, 20, 5])
  const b = rows('b', [99, 98, 97, 96, 61, 30, 29])
  const merged = [...a, ...b].sort((x, y) => y.updatedAt - x.updatedAt)
  const picks: [string, (id: string) => boolean][] = [
    ['只要 a 的', (id) => id.startsWith('a')],
    ['隔一个要一个', (id) => Number(id.slice(1)) % 2 === 0],
    ['只要最后一个', (id) => id === 'a9'],
    ['只要最前一个', (id) => id === 'a1'],
    ['一个都不要', () => false],
  ]
  for (const [name, pick] of picks) {
    const expected = merged.filter((row) => pick(row.id)).map((row) => row.id)
    for (const limit of [1, 2, 3, 5, 50]) {
      const sources = [source('a', a), source('b', b)]
      const all: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 100; page++) {
        const result = await mergeThreadList({
          sources,
          limit,
          cursor,
          filters: {},
          accept: (row) => pick(row.id),
        })
        assert.ok(result.data.length <= limit)
        // 留下的都打上了 harness
        assert.ok(result.data.every((row) => row.harness === row.id.slice(0, 1)))
        all.push(...result.data.map((row) => row.id))
        cursor = result.nextCursor
        if (cursor === null) break
      }
      assert.equal(cursor, null, `${name}，每页 ${limit} 个：没有翻到头`)
      assert.deepEqual(all, expected, `${name}，每页 ${limit} 个`)
    }
  }
  // 要的那个排在很后面：一页就给出来了，中间筛掉的那些不用客户端一页页空翻
  const far = source('a', a)
  const result = await mergeThreadList({
    sources: [far],
    limit: 2,
    cursor: null,
    filters: {},
    accept: (row) => row.id === 'a9',
  })
  assert.deepEqual(
    result.data.map((row) => row.id),
    ['a9'],
  )
  assert.equal(result.nextCursor, null)
  assert.ok(far.calls.length > 1)
})
