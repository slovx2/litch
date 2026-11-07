import assert from 'node:assert/strict'
import test from 'node:test'
import { execute } from '../../../../../packages/chrome-extension/src/requests.mjs'
import type { ExtensionState } from '../../../../../packages/chrome-extension/src/state.mjs'
import type { ChromeListedTab } from '../../../../../packages/protocol/src/chrome-browser.mjs'

const tabs = [
  { id: 1, windowId: 10, active: true },
  { id: 2, windowId: 10, active: false },
  { id: 3, windowId: 20, active: false },
  { id: 4, windowId: 20, active: true },
].map((tab) => ({ ...tab, title: `Tab ${tab.id}`, url: `https://fixture.test/${tab.id}` }))

async function list(lastFocused: object | Error, source = tabs): Promise<ChromeListedTab[]> {
  const state = {
    epoch: 'epoch',
    stopped: false,
    paused: new Set(),
    grants: new Map(),
    generations: new Map(),
    chrome: {
      windows: {
        getLastFocused: async () => {
          if (lastFocused instanceof Error) throw lastFocused
          return lastFocused
        },
        update: () => assert.fail('列举不得改变窗口焦点'),
      },
      tabs: {
        query: async (query: unknown) => {
          assert.deepEqual(query, {})
          return source
        },
        get: async (id: number) => source.find((tab) => tab.id === id),
        update: () => assert.fail('列举不得切换活动标签'),
      },
      webNavigation: {
        getAllFrames: async () => [{ url: 'https://fixture.test/' }],
      },
      // 列举要带 DevTools 目标身份（跨扩展互斥用）；只读，不 attach。
      debugger: {
        getTargets: async () =>
          source.map((tab) => ({ tabId: tab.id, id: tab.id.toString(16).padStart(32, '0') })),
      },
    },
  } as unknown as ExtensionState
  return (await execute(state, {
    kind: 'request',
    id: 'list',
    epoch: 'epoch',
    op: 'list',
    args: {},
  })) as ChromeListedTab[]
}

test('多窗口多标签：每窗口的 active 独立，最后焦点窗口仅标记对应窗口', async () => {
  const result = await list({ id: 20, focused: true })
  assert.deepEqual(
    result.map((tab) => [tab.id, tab.active, tab.lastFocusedWindow]),
    [
      [1, true, false],
      [2, false, false],
      [3, false, true],
      [4, true, true],
    ],
  )
})

test('Chrome 当前没有前台窗口，仍采用最后获得焦点的窗口', async () => {
  const result = await list({ id: 10, focused: false })
  assert.deepEqual(
    result.filter((tab) => tab.active && tab.lastFocusedWindow).map((tab) => tab.id),
    [1],
  )
})

test('没有最后焦点窗口或读取失败时不猜测 current，也不中断标签列表', async () => {
  for (const window of [{ id: -1 }, {}, new Error('No windows')]) {
    const result = await list(window)
    assert.equal(result.length, 4)
    assert.ok(result.every((tab) => tab.lastFocusedWindow === false))
  }
  assert.deepEqual(await list(new Error('No windows'), []), [])
})

test('最后焦点窗口不存在于列表时不退回另一个窗口的活动标签', async () => {
  const result = await list({ id: 99 })
  assert.ok(result.every((tab) => tab.lastFocusedWindow === false))
})

test('最后焦点窗口的活动页不可控制时，不把同窗口其他标签标为 current', async () => {
  const result = await list(
    { id: 20 },
    tabs.map((tab) => (tab.id === 4 ? { ...tab, url: 'chrome://settings/' } : tab)),
  )
  assert.deepEqual(
    result.map((tab) => tab.id),
    [1, 2, 3],
  )
  assert.ok(result.every((tab) => !(tab.active && tab.lastFocusedWindow)))
})
