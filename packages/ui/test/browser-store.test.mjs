// 侧面板浏览器标签：一个会话眼前显示哪个网页标签（chooseTab）、哪些标签算这个会话的（tabsOf）。
// 不起浏览器，也没有桌面外壳（window.litchBrowser 不存在时 store.ts 什么都不接）。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { chooseTab, tabsOf } = await import('../src/side/browser/store.ts')

const tab = (id, threadId, extra = {}) => ({
  id,
  owner: { deviceId: 'local', threadId },
  kind: 'agent',
  url: 'about:blank',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentActive: false,
  keep: false,
  ...extra,
})

test('只算这个会话的标签', () => {
  const all = [
    tab('t1', 'a'),
    tab('t2', 'b'),
    tab('t3', 'a'),
    { ...tab('t4', 'a'), owner: { deviceId: 'build', threadId: 'a' } },
  ]
  assert.deepEqual(
    tabsOf(all, { deviceId: 'local', threadId: 'a' }).map((one) => one.id),
    ['t1', 't3'],
  )
  assert.deepEqual(tabsOf(all, { deviceId: 'local', threadId: '' }), [])
})

test('眼前显示哪个：代理要给人看的、人点的、代理在用的、最近开的', () => {
  const mine = [tab('t1', 'a'), tab('t2', 'a', { agentActive: true }), tab('t3', 'a')]
  assert.equal(chooseTab(mine, undefined, undefined), 't2')
  assert.equal(chooseTab(mine, 't1', undefined), 't1')
  assert.equal(chooseTab(mine, 't1', 't3'), 't3')
  // 点过的、要看的已经关了，就往下退
  assert.equal(chooseTab(mine, 't9', 't8'), 't2')
  assert.equal(chooseTab([tab('t1', 'a'), tab('t5', 'a')], undefined, undefined), 't5')
  assert.equal(chooseTab([], 't1', undefined), null)
})
