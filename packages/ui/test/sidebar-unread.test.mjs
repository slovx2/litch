import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropNativeChildren, keepSessions, keptAnyway } from '../src/sidebar/filter.ts'
import { kidsShown, MAX_DEPTH, treeUnread, unreadIn, withAncestors } from '../src/sidebar/tree.ts'

const groups = { stoneage: ['child', 'ordinary'], wind: ['parent'] }
const children = { parent: ['child'] }

test('跨项目子会话未读只记在实际显示的父项组，点父项不代清子项', () => {
  const counts = treeUnread(groups, children, ['child', 'parent'])
  assert.deepEqual(counts, { wind: 2 })
  assert.equal(unreadIn(counts, 'stoneage'), 0)
  assert.equal(unreadIn(counts, ['stoneage', 'wind']), 2)
  assert.equal(unreadIn(counts, null), 2)
  assert.deepEqual(treeUnread(groups, children, ['child']), { wind: 1 })
  assert.deepEqual(treeUnread(groups, children, []), {})
})

test('父项被筛掉时子项回到自身项目，未读随相同筛选迁移', () => {
  const harnesses = { child: 'codex', ordinary: 'codex', parent: 'claude' }
  const shown = (filter, showActive) => {
    const keep = keptAnyway(() => false, showActive, ['child'])
    return Object.fromEntries(
      Object.entries(groups).map(([key, ids]) => [key, keepSessions(ids, filter, harnesses, keep)]),
    )
  }
  assert.deepEqual(treeUnread(shown(['codex'], false), children, ['child']), { stoneage: 1 })
  assert.deepEqual(treeUnread(shown(['claude'], false), children, ['child']), {})
  assert.deepEqual(treeUnread(shown(['claude'], true), children, ['child']), { wind: 1 })
})

test('隐藏原生子会话时未读及它的父链保留，可见开关不重复计数', () => {
  const lineage = { parent: ['middle'], middle: ['native'] }
  const directory = { a: ['parent'], b: ['middle', 'native', 'quiet'] }
  const kept = withAncestors(['native'], lineage)
  for (const hidden of [[], ['middle', 'native', 'quiet']]) {
    const shown = Object.fromEntries(
      Object.entries(directory).map(([key, ids]) => [
        key,
        dropNativeChildren(ids, hidden, (id) => kept.has(id)),
      ]),
    )
    assert.deepEqual(treeUnread(shown, lineage, ['native']), { a: 1 })
  }
  assert.deepEqual(
    kidsShown(['middle'], true, (id) => kept.has(id)),
    ['middle'],
  )
  assert.deepEqual(
    kidsShown(['native'], true, (id) => kept.has(id)),
    ['native'],
  )
  // 同一集合用于“展示更多”：根项也不能把未读后代藏住。
  assert.equal(kept.has('parent'), true)
})

test('归档、经理、工作线及被隐藏的项不在普通目录中，不贡献组头未读', () => {
  const hidden = ['archived', 'manager', 'line', 'grandchild', 'native']
  const fullChildren = {
    ...children,
    manager: ['line'],
    line: ['grandchild'],
    parent: ['archived'],
  }
  assert.deepEqual(treeUnread(groups, fullChildren, hidden), {})
})

test('跨项目多层、置顶和自定义组沿可见根项归并；父项不存在则按列表单列', () => {
  const directory = { ':pinned': ['parent'], ':section:later': ['middle'], a: ['child', 'orphan'] }
  const lineage = { parent: ['middle'], middle: ['child'], absent: ['orphan'] }
  assert.deepEqual(treeUnread(directory, lineage, ['middle', 'child', 'orphan']), {
    ':pinned': 2,
    a: 1,
  })
})

test('环和超过列表深度上限的项不制造无法点开的未读', () => {
  const ids = Array.from({ length: MAX_DEPTH + 2 }, (_, i) => `s${i}`)
  const lineage = Object.fromEntries(ids.slice(0, -1).map((id, i) => [id, [ids[i + 1]]]))
  assert.deepEqual(treeUnread({ a: ids }, lineage, [ids.at(-1)]), {})
  assert.deepEqual(treeUnread({ a: ids }, lineage, [ids[MAX_DEPTH]]), { a: 1 })
  assert.deepEqual(treeUnread({ a: ['a', 'b'] }, { a: ['b'], b: ['a'] }, ['a', 'b']), {})
  assert.deepEqual([...withAncestors(['a'], { a: ['b'], b: ['a'] })].sort(), ['a', 'b'])
})
