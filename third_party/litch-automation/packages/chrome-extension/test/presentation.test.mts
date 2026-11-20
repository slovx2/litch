import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChromeGrant } from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { TabPresentation } from '../src/presentation.mjs'

function fixture() {
  const tabs = new Map(
    [1, 2].map((id) => [id, { id, groupId: -1, windowId: 1, pinned: false, index: id }]),
  )
  const groups = new Map<number, { id: number; color: string; title: string; collapsed: boolean }>()
  const badges = new Map<number, string>()
  const saved: Record<string, unknown> = {}
  const writes: unknown[] = []
  const chrome = {
    tabs: {
      get: async (id: number) => {
        const tab = tabs.get(id)
        assert.ok(tab)
        return { ...tab }
      },
      group: async ({ tabIds: [id], groupId }: { tabIds: number[]; groupId?: number }) => {
        if (groupId === undefined) {
          groupId = groups.size + 10
          groups.set(groupId, { id: groupId, color: 'grey', title: '', collapsed: false })
        }
        const tab = id === undefined ? undefined : tabs.get(id)
        assert.ok(tab)
        tab.groupId = groupId
        return groupId
      },
      ungroup: async (id: number) => {
        const tab = tabs.get(id)
        assert.ok(tab)
        tab.groupId = -1
      },
      move: async () => {},
    },
    tabGroups: {
      get: async (id: number) => groups.get(id),
      update: async (id: number, delta: { color: string; title: string }) => {
        writes.push(['group', id, delta.color])
        Object.assign(groups.get(id) ?? {}, delta)
      },
    },
    action: {
      getBadgeText: async ({ tabId }: { tabId: number }) => badges.get(tabId) ?? '',
      setBadgeText: async ({ tabId, text }: { tabId: number; text: string | null }) => {
        writes.push(['badge', tabId, text])
        if (text === null) badges.delete(tabId)
        else badges.set(tabId, text)
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    storage: {
      local: {
        get: async () => structuredClone(saved),
        set: async (values: object) => Object.assign(saved, structuredClone(values)),
        remove: async (key: string) => {
          delete saved[key]
        },
      },
    },
  }
  const grant = (tabId: number): ChromeGrant => ({
    tabId,
    leaseId: `lease-${tabId}`,
    owner: { deviceId: 'device', threadId: 'session', turnId: 'turn' },
    sessionTitle: '测试',
    origins: [],
    expiresAt: Date.now() + 15_000,
    keep: true,
    original: true,
  })
  return {
    view: new TabPresentation(chrome, 'Litch', 'test:'),
    grant,
    badges,
    tabs,
    groups,
    writes,
  }
}

test('有效租约保持徽标；加入或交还一个同组标签不重涂组，旧租约通知不再画', async () => {
  const { view, grant, tabs, groups, writes, badges } = fixture()
  await view.claim(grant(1))
  await view.claim(grant(2))
  const groupId = tabs.get(1)?.groupId
  assert.ok(groupId !== undefined && groupId >= 0)
  assert.equal(tabs.get(2)?.groupId, groupId)
  for (let tick = 0; tick < 5; tick++) await view.retry(new Set(['lease-1', 'lease-2']))
  await view.navigated(2, 'lease-2')
  assert.deepEqual(writes, [
    ['badge', 1, 'AI'],
    ['group', groupId, 'orange'],
    ['badge', 2, 'AI'],
  ])
  await view.release(1, 'lease-1')
  await view.navigated(1, 'lease-1')
  assert.equal(tabs.get(1)?.groupId, -1)
  assert.equal(badges.get(2), 'AI')
  assert.equal(groups.get(groupId)?.color, 'orange')
  await view.retry(new Set()) // 租约消失时，重试路径也能复原。
  assert.deepEqual(writes.slice(3), [
    ['badge', 1, null],
    ['badge', 2, null],
  ])
  assert.equal(tabs.get(2)?.groupId, -1)
})

test('Chrome 清除了导航标签的徽标才补画，不重复更新分组', async () => {
  const { view, grant, badges, writes } = fixture()
  await view.claim(grant(1))
  await view.navigated(1, 'old-lease')
  assert.equal(writes.length, 2)
  badges.delete(1)
  await view.navigated(1, 'lease-1')
  await view.navigated(1, 'lease-1')
  assert.deepEqual(writes.slice(2), [['badge', 1, 'AI']])
})
