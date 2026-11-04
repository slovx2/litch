import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChromeGrant } from '../../../../../packages/protocol/src/chrome-browser.mjs'
import { TabPresentation } from '../../../../chrome-extension/src/presentation.mjs'

function fixture() {
  const saved: Record<string, unknown> = {}
  const tabs = new Map<number, any>()
  const groups = new Map<number, any>()
  const badges = new Map<number, string>()
  let seq = 10
  let fail = false
  const removeEmpty = () => {
    for (const id of groups.keys())
      if (![...tabs.values()].some((tab) => tab.groupId === id)) groups.delete(id)
  }
  const chrome = {
    storage: {
      local: {
        get: async () => structuredClone(saved),
        set: async (values: Record<string, unknown>) =>
          Object.assign(saved, structuredClone(values)),
        remove: async (key: string) => {
          delete saved[key]
        },
      },
    },
    tabs: {
      remove: async (id: number) => {
        tabs.delete(id)
        removeEmpty()
      },
      get: async (id: number) => {
        if (!tabs.has(id)) throw Error('closed')
        return { ...tabs.get(id) }
      },
      update: async (id: number, values: object) => Object.assign(tabs.get(id), values),
      move: async (id: number, values: object) => Object.assign(tabs.get(id), values),
      group: async ({ tabIds, groupId, createProperties }: any) => {
        if (fail) throw Error('Chrome temporarily unavailable')
        const id = groupId ?? ++seq
        if (!groups.has(id))
          groups.set(id, {
            id,
            windowId: createProperties.windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          })
        for (const tabId of tabIds) tabs.get(tabId).groupId = id
        removeEmpty()
        return id
      },
      ungroup: async (id: number) => {
        if (fail) throw Error('Chrome temporarily unavailable')
        tabs.get(id).groupId = -1
        removeEmpty()
      },
    },
    tabGroups: {
      get: async (id: number) => {
        if (!groups.has(id)) throw Error('gone')
        return { ...groups.get(id) }
      },
      update: async (id: number, values: object) => Object.assign(groups.get(id), values),
    },
    action: {
      setBadgeText: async ({ tabId, text }: any) => badges.set(tabId, text),
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  }
  const add = (id: number, groupId = -1, pinned = false, windowId = 1) => {
    tabs.set(id, { id, groupId, pinned, windowId, index: id, title: `tab ${id}` })
    if (groupId >= 0)
      groups.set(groupId, {
        id: groupId,
        windowId,
        title: '用户资料',
        color: 'purple',
        collapsed: true,
      })
  }
  const grant = (id: number, threadId = 'session', leaseId = `lease-${id}`): ChromeGrant => ({
    tabId: id,
    leaseId,
    sessionTitle: '调研当前任务',
    owner: { deviceId: 'local', threadId, turnId: 'turn' },
    original: true,
    keep: true,
    expiresAt: Date.now() + 15_000,
    origins: ['about:blank'],
  })
  return {
    chrome,
    tabs,
    groups,
    badges,
    saved,
    add,
    grant,
    fail: (value: boolean) => {
      fail = value
    },
    presentation: new TabPresentation(chrome),
  }
}

test('同会话同窗口复用组，不跨窗口搬标签；还原单成员原组、顺序和固定状态', async () => {
  const f = fixture()
  f.add(1, 7)
  f.add(2, -1, true)
  f.add(3, -1, false, 2)
  for (const id of [1, 2, 3]) await f.presentation.claim(f.grant(id))
  assert.equal(f.tabs.get(1).groupId, f.tabs.get(2).groupId)
  assert.notEqual(f.tabs.get(1).groupId, f.tabs.get(3).groupId)
  assert.match(f.groups.get(f.tabs.get(1).groupId).title, /调研当前任务/)
  assert.equal(f.tabs.get(2).pinned, false)
  for (const id of [1, 2, 3]) await f.presentation.release(id, `lease-${id}`)
  assert.equal(f.groups.get(f.tabs.get(1).groupId).title, '用户资料')
  assert.equal(f.groups.get(f.tabs.get(1).groupId).color, 'purple')
  assert.equal(f.groups.get(f.tabs.get(1).groupId).collapsed, true)
  assert.equal(f.tabs.get(1).index, 1)
  assert.equal(f.tabs.get(2).pinned, true)
  assert.equal(f.tabs.get(2).groupId, -1)
  assert.equal(Object.keys(f.saved).length, 0)
})

test('并发活动计数、失败归零和旧租约迟到清理不覆盖新状态', async () => {
  const f = fixture()
  f.add(1)
  await f.presentation.claim(f.grant(1))
  await f.presentation.active(1, 'lease-1', true)
  await f.presentation.active(1, 'lease-1', true)
  await f.presentation.active(1, 'lease-1', false)
  assert.equal(f.badges.get(1), 'AI')
  assert.equal(f.groups.get(f.tabs.get(1).groupId).color, 'orange')
  await f.presentation.active(1, 'lease-1', false)
  assert.equal(f.badges.get(1), '')
  assert.equal(f.groups.get(f.tabs.get(1).groupId).color, 'blue')
  await f.presentation.release(1, 'lease-1')
  await f.presentation.claim(f.grant(1, 'session', 'new-lease'))
  await f.presentation.active(1, 'new-lease', true)
  await f.presentation.release(1, 'lease-1')
  await f.presentation.active(1, 'lease-1', false)
  assert.equal(f.badges.get(1), 'AI')
})

test('扩展重启从 local 日志恢复；恢复失败保留日志并重试；用户手动移动优先', async () => {
  const f = fixture()
  f.add(1)
  f.add(2)
  await f.presentation.claim(f.grant(1))
  await f.presentation.claim(f.grant(2))
  await f.presentation.active(1, 'lease-1', true)
  f.tabs.get(2).windowId = 3
  f.tabs.get(2).groupId = -1
  f.fail(true)
  const restart = new TabPresentation(f.chrome)
  await restart.recover()
  assert.ok(Object.keys(f.saved).length > 0)
  f.fail(false)
  await restart.retry(new Set())
  assert.equal(f.tabs.get(1).groupId, -1)
  assert.equal(f.badges.get(1), '')
  assert.equal(f.tabs.get(2).windowId, 3)
  assert.equal(Object.keys(f.saved).length, 0)
})

test('恢复记录在扩展重载后关闭代理临时标签，keep 标签移出组交还', async () => {
  const f = fixture()
  f.add(1)
  f.add(2)
  await f.presentation.claim({ ...f.grant(1), original: false, keep: false })
  await f.presentation.claim({ ...f.grant(2), original: false, keep: false })
  await f.presentation.keep(2, 'lease-2', true)
  await new TabPresentation(f.chrome).recover()
  assert.equal(f.tabs.has(1), false)
  assert.equal(f.tabs.get(2).groupId, -1)
  assert.equal(Object.keys(f.saved).length, 0)
})
