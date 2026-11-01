import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readProjectionSettings } from '../src/sidebar/projection-state.ts'

test('投影组默认各五条、不聚合、展开；设置独立并拒绝损坏条数', () => {
  const defaults = { collapsed: false, byProject: false, first: 5 }
  assert.deepEqual(readProjectionSettings(null), { unread: defaults, recent: defaults })
  assert.deepEqual(
    readProjectionSettings({
      unread: { collapsed: true, byProject: true, first: 20 },
      recent: { first: -1 },
    }),
    { unread: { collapsed: true, byProject: true, first: 20 }, recent: defaults },
  )
  assert.equal(readProjectionSettings({ recent: { first: 10 } }).recent.first, 10)
})
