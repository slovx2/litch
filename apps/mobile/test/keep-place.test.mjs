// 展开收起时被点的那一行不动（src/detail/keep-place.ts）：对着一个按倒置列表排的假列表，
// 在被点的行下面插几行、被点的行自己变高，看滚回去的位置让它的上沿还在原处。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keepPlace, offsetFor, rowBelow, topOf } from '../src/detail/keep-place.ts'
import './helpers.mjs'

/**
 * 假的 FlashList：data 新的在前，下标 0 的布局 y 是 0（倒置之后在最下面），表头占 head 高。
 * scrollToOffset 记下要滚到哪；滚到的位置超过 max（原生那边内容还没长高）时截短，列表记的偏移跟着变
 */
function fakeList(rows, { head = 30, offset = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const list = {
    max,
    props: { data: rows },
    heights: Object.fromEntries(rows.map((row) => [row.key, row.h])),
    offset,
    head,
    scrolled: [],
    getLayout(index) {
      const data = list.props.data
      if (index < 0 || index >= data.length) return undefined
      let y = 0
      for (let at = 0; at < index; at++) y += list.heights[data[at].key]
      return { x: 0, y, width: 400, height: list.heights[data[index].key] }
    },
    getFirstItemOffset: () => list.head,
    getAbsoluteLastScrollOffset: () => list.offset,
    scrollToOffset: ({ offset: to }) => {
      list.scrolled.push(to)
      list.offset = Math.min(to, list.max)
    },
  }
  return list
}

const row = (key, h) => ({ key, h })
const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

test('上沿离底边多远：行的 y 加高，加上表头，减去滚过的', () => {
  const list = fakeList([row('status', 20), row('md', 100), row('group', 32), row('user', 40)], {
    offset: 50,
  })
  // group 在下标 2：y = 120，高 32，表头 30
  assert.equal(topOf(list, 'group'), 120 + 32 + 30 - 50)
  assert.equal(topOf(list, 'nope'), null)
})

test('展开一组：步骤插在摘要下面，滚回去让摘要不动、下面的往下推', async () => {
  const list = fakeList([row('status', 20), row('md', 100), row('group', 32), row('user', 40)], {
    offset: 50,
  })
  const before = topOf(list, 'group')
  keepPlace(list, 'group', () => {
    // 新的在前：收起行、两步插在摘要（更旧）和回答（更新）之间
    const next = [
      row('status', 20),
      row('md', 100),
      row('end', 32),
      row('s2', 40),
      row('s1', 40),
      row('group', 32),
      row('user', 40),
    ]
    list.props.data = next
    for (const each of next) list.heights[each.key] = each.h
  })
  await tick()
  // 多出 112 高，滚上去 112，摘要的上沿还在原处；之后几帧位置一样就不再滚
  assert.deepEqual(list.scrolled, [50 + 112])
  assert.equal(topOf(list, 'group'), before)
})

test('第一次滚被截短（原生那边内容还没长高）：下一帧按真的偏移再滚', async () => {
  const list = fakeList([row('md', 100), row('group', 32), row('user', 40)], {
    offset: 50,
    max: 60,
  })
  const before = topOf(list, 'group')
  keepPlace(list, 'group', () => {
    list.props.data = [
      row('md', 100),
      row('end', 32),
      row('s1', 40),
      row('group', 32),
      row('user', 40),
    ]
    for (const each of list.props.data) list.heights[each.key] = each.h
  })
  await Promise.resolve()
  assert.equal(list.offset, 60)
  list.max = 1000
  await tick()
  assert.deepEqual(list.scrolled, [122, 122])
  assert.equal(topOf(list, 'group'), before)
})

test('收起一组（点摘要）：滚回来，偏移不会小于 0', async () => {
  const list = fakeList(
    [row('status', 20), row('end', 32), row('s1', 40), row('group', 32), row('user', 40)],
    { offset: 30 },
  )
  keepPlace(list, 'group', () => {
    list.props.data = [row('status', 20), row('group', 32), row('user', 40)]
  })
  await tick()
  // 少了 72 高，本该滚到 30 - 72，到底了就停在 0
  assert.deepEqual(list.scrolled, [0])
})

test('展开一步的细节：这一步自己变高，标题（上沿）不动', async () => {
  const list = fakeList([row('status', 20), row('s2', 40), row('s1', 40), row('group', 32)])
  keepPlace(list, 's1', () => {
    list.heights.s1 = 240
  })
  await tick()
  assert.deepEqual(list.scrolled, [200])
})

test('没变高、拿不到列表、行不在了：不滚，照常做', async () => {
  const list = fakeList([row('status', 20), row('group', 32)])
  let done = 0
  keepPlace(list, 'group', () => done++)
  keepPlace(null, 'group', () => done++)
  keepPlace(list, 'nope', () => done++)
  await tick()
  assert.equal(done, 3)
  assert.deepEqual(list.scrolled, [])
  assert.equal(offsetFor(list, 'nope', 0), null)
})

test('点“收起”：留住它下面那一行，摘要落到“收起”原来的地方', async () => {
  const list = fakeList(
    [row('md', 100), row('end', 32), row('s1', 40), row('group', 32), row('user', 40)],
    { offset: 200 },
  )
  assert.equal(rowBelow(list, 'end'), 'md')
  assert.equal(rowBelow(list, 'md'), null)
  const below = topOf(list, 'md')
  const endTop = topOf(list, 'end')
  keepPlace(list, 'md', () => {
    list.props.data = [row('md', 100), row('group', 32), row('user', 40)]
  })
  await tick()
  // 下面那一行在布局上本来就没动，不用滚；摘要（和“收起”一样高）正好落在“收起”原来的地方
  assert.deepEqual(list.scrolled, [])
  assert.equal(topOf(list, 'md'), below)
  assert.equal(topOf(list, 'group'), endTop)
})
