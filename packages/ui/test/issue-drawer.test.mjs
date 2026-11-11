import assert from 'node:assert/strict'
import test from 'node:test'
import { kinds, threadFixture } from './issue-thread-fixture.mjs'

for (const kind of kinds) {
  test(`${kind}：讨论抽屉不重复正文或选项，查看正文优先定位列表`, () => {
    const f = threadFixture('desktop', kind, { found: true })
    const tree = f.render()
    assert.equal(f.original(), false)
    assert.ok(tree.some((node) => node.type === 'discussion'))
    if (kind !== 'ordinary')
      assert.equal(typeof tree.find((node) => node.type === 'discussion').props.onAsk, 'function')
    assert.equal(
      tree.some((node) => node.type === 'quick'),
      false,
    )
    f.reveal()
    assert.equal(f.located(), 1)
    assert.equal(f.original(), false)
  })
  test(`${kind}：不在列表时正文默认收起，点击可就地展开再收起`, () => {
    const f = threadFixture('desktop', kind)
    f.render()
    assert.equal(f.original(), false)
    f.reveal()
    assert.equal(f.original(), true)
    f.reveal()
    assert.equal(f.original(), false)
    f.reveal()
    f.setFound(true)
    f.reveal()
    assert.equal(f.original(), false)
  })
}
