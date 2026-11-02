import assert from 'node:assert/strict'
import { test } from 'node:test'

const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
}
const { sidebarNow, setSidebarAutoLocate } = await import('../src/sidebar/state.ts')

test('自动定位默认打开，开关保存且不改变组的折叠状态', () => {
  assert.equal(sidebarNow().autoLocate, true)
  const folds = sidebarNow().folds
  setSidebarAutoLocate(false)
  assert.equal(sidebarNow().autoLocate, false)
  assert.equal(JSON.parse(values.get('litch.sidebar')).autoLocate, false)
  assert.equal(sidebarNow().folds, folds)
  setSidebarAutoLocate(true)
  assert.equal(sidebarNow().autoLocate, true)
  assert.equal(JSON.parse(values.get('litch.sidebar')).autoLocate, true)
})

test('重开后保留关闭定位的选择', async () => {
  values.set('litch.sidebar', JSON.stringify({ autoLocate: false }))
  const reloaded = await import('../src/sidebar/state.ts?auto-locate-reload')
  assert.equal(reloaded.sidebarNow().autoLocate, false)
})
