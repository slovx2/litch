import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_ISSUE_METHOD as M,
  type ManagerIssue,
  managerIssueFixture,
} from '../../protocol/src/manager-issues.mjs'
import type { ManagersHost } from '../src/device/manager.mjs'
import { ManagerIssueCache } from '../src/device/manager-issues.mjs'
import { settle } from './helpers.mjs'

function fixture() {
  const issue: ManagerIssue = structuredClone(managerIssueFixture.newOrdinary)
  issue.unread = true
  const query = { managerId: 'm', order: 'newest' as const }
  const calls: string[] = []
  let block: ((method: string) => Promise<void>) | null = null
  const host = {
    online: () => true,
    features: () => ({ issues: true, issueDiscussions: true }),
    log() {},
    request: async (method: string, params: unknown) => {
      calls.push(method)
      await block?.(method)
      if (method === M.list)
        return { page: { query: params, entries: [], total: 0, nextCursor: null } }
      return { issue: structuredClone(issue) }
    },
  } as unknown as ManagersHost
  const cache = new ManagerIssueCache(host, 'm', () => {})
  return {
    cache,
    calls,
    issue,
    query,
    block: (next: typeof block) => {
      block = next
    },
  }
}

test('慢设备：1000次同页/已读请求各合并为一条，已读成功不会触发全页刷新', async () => {
  const f = fixture()
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  f.block(() => wait)
  const seen = { managerId: 'm', id: f.issue.id, revision: f.issue.revision }
  const requests = Array.from({ length: 1000 }, () => [
    f.cache.call(M.list, f.query),
    f.cache.call(M.seen, seen),
  ]).flat()
  await settle()
  assert.deepEqual(f.calls, [M.list, M.seen], '两种请求互不串行阻塞')
  f.issue.unread = false
  release()
  await Promise.all(requests)
  await settle()
  assert.deepEqual(f.calls, [M.list, M.seen])
})

test('超时后发布失败不立即重试；冷却结束或重连后可恢复', async (t) => {
  t.mock.method(Date, 'now', () => 1000)
  const f = fixture()
  f.block(async () => {
    throw new Error('timeout')
  })
  await assert.rejects(f.cache.call(M.list, f.query), /timeout/)
  const failed = await Promise.allSettled(
    Array.from({ length: 1000 }, () => f.cache.call(M.list, f.query)),
  )
  assert.ok(failed.every((result) => result.status === 'rejected'))
  assert.equal(f.calls.length, 1)
  f.block(null)
  t.mock.method(Date, 'now', () => 31_001)
  await f.cache.call(M.list, f.query)
  assert.equal(f.calls.length, 2)
  f.block(async () => {
    throw new Error('timeout')
  })
  await assert.rejects(f.cache.call(M.read, { managerId: 'm', id: f.issue.id }))
  f.cache.stop()
  f.block(null)
  await f.cache.refresh()
  assert.equal(f.calls.at(-1), M.read, '断线前的已订阅详情在恢复后重读')
})

test('通知风暴：跨帧通知在50ms窗口合并；慢读取期间的新通知只补读一轮', async (t) => {
  const f = fixture()
  await f.cache.call(M.list, f.query)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.calls.length = 0
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  f.block(() => wait)
  const refreshing = f.cache.refresh()
  for (let n = 0; n < 1000; n++) {
    void f.cache.refresh()
    if (n % 100 === 0) await settle()
  }
  t.mock.timers.tick(49)
  await settle()
  assert.equal(f.calls.length, 0)
  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(f.calls, [M.list])
  for (let n = 0; n < 1000; n++) void f.cache.refresh()
  f.block(null)
  release()
  await settle()
  t.mock.timers.tick(50)
  await refreshing
  assert.deepEqual(f.calls, [M.list, M.list])
})
