import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChromeEvent } from '../../automation-contracts/src/litch/chrome-browser.mjs'
import type { ClientToolInvocation } from '../../browser/src/tool-port.mjs'
import { type ChromeBridge, ChromeBridgeError } from '../src/bridge.mjs'
import { ChromeExecutor, type ChromeExecutorOptions } from '../src/executor.mjs'

function fixture(options: Partial<ChromeExecutorOptions> = {}) {
  const tab = {
    id: 1,
    targetId: 'fixture-target',
    generation: 1,
    loading: false,
    title: 'Fixture',
    url: 'https://fixture.test/',
    origins: ['https://fixture.test'],
    busy: false,
    active: true,
    lastFocusedWindow: true,
  }
  const instance = { id: 'fixture', epoch: '1', stopped: false }
  const calls: string[] = []
  let receive: (id: string, event: ChromeEvent) => void = () => {}
  let expired = false
  let duplicate = false
  let approve = true
  let seq = 0
  const executor = new ChromeExecutor({
    namespace: 'test_browser',
    productName: 'Test',
    allowed: () => true,
    bridge: {
      instances: () => [instance],
      onEvent: (fn: typeof receive) => {
        receive = fn
        return () => {}
      },
      call: async (_id: string, req: { op: string; args?: { method?: string } }) => {
        calls.push(req.op)
        if (req.op === 'list') return duplicate ? [tab, { ...tab, id: 2 }] : [tab]
        if (req.op === 'renew' && expired) {
          expired = false
          throw new ChromeBridgeError('staleLease', 'Expired')
        }
        if (req.op === 'claim') return { tab: { ...tab } }
        if (req.op === 'command') {
          if (req.args?.method === 'Page.getFrameTree')
            return { frameTree: { frame: { id: 'f', url: tab.url } } }
          if (req.args?.method === 'Accessibility.getFullAXTree')
            return {
              nodes: [
                {
                  nodeId: '1',
                  role: { value: 'button' },
                  name: { value: 'Save' },
                  backendDOMNodeId: 1,
                },
              ],
            }
        }
        return {}
      },
    } as unknown as ChromeBridge,
    ...options,
  })
  const base: ClientToolInvocation = {
    id: 'i',
    callId: 'i',
    namespace: 'test_browser',
    tool: '',
    arguments: {},
    device: { id: 'local', name: 'Fixture', kind: 'local', target: null },
    threadId: 's',
    turnId: 't',
    harness: null,
    sessionTitle: '商店草稿',
    cwd: null,
  }
  const call = (tool: string, args: Record<string, unknown>, threadId = 's') =>
    executor.call(
      { ...base, tool, arguments: args, threadId, callId: String(++seq) },
      {
        signal: new AbortController().signal,
        ask: async () => (approve ? 'session' : 'decline'),
      },
    )
  return {
    executor,
    call,
    calls,
    tab,
    instance,
    modelCalls: () => seq,
    expire: () => {
      expired = true
    },
    reconnect: () => {
      instance.epoch = '2'
      receive(instance.id, { kind: 'disconnected' })
    },
    duplicate: () => {
      duplicate = true
    },
    deny: () => {
      approve = false
    },
  }
}
const text = (r: { contentItems: unknown[] }) =>
  r.contentItems.map((i) => (i as { text?: string }).text ?? '').join('\n')
const first = (r: { contentItems: unknown[] }) =>
  JSON.parse((r.contentItems[0] as { text: string }).text)
const ref = (r: { contentItems: unknown[] }) => /\[ref=([^\]]+)\]/.exec(text(r))![1]

test('两会话交接：未释放时报标题；最后一张释放完成后交还原生输入，B 立即认领', async (t) => {
  const released: string[] = []
  const f = fixture({
    onSessionReleased: async (owner) => {
      released.push(owner.threadId)
    },
  })
  t.after(() => f.executor.dispose())
  const a = first(await f.call('ensure_claimed', { targetId: 'chrome:fixture' }))
  const denied = await f.call('ensure_claimed', { targetId: 'chrome:fixture' }, 'b')
  assert.equal(denied.success, false)
  assert.match(text(denied), /商店草稿/)
  assert.match(text(denied), /release\(tabId\)/)
  assert.deepEqual(released, [])
  assert.equal((await f.call('release', { tabId: a.tabId })).success, true)
  assert.deepEqual(released, ['s'])
  assert.equal((await f.call('ensure_claimed', { targetId: 'chrome:fixture' }, 'b')).success, true)
})

test('会话结束与空闲回收都释放标签；旧回合不能再取回', async (t) => {
  let now = 0
  const released: string[] = []
  const f = fixture({
    now: () => now,
    idleMs: 100,
    onSessionReleased: async (owner) => {
      released.push(owner.threadId)
    },
  })
  t.after(() => f.executor.dispose())
  assert.equal((await f.call('ensure_claimed', { targetId: 'chrome:fixture' })).success, true)
  now = 101
  await f.executor.collectIdle()
  assert.deepEqual(released, ['s'])
  assert.equal((await f.call('ensure_claimed', { targetId: 'chrome:fixture' }, 'b')).success, true)
  f.executor.turnEnded({ deviceId: 'local', threadId: 'b', turnId: 't' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(released, ['s', 'b'])
  assert.equal((await f.call('ensure_claimed', { targetId: 'chrome:fixture' }, 'b')).success, false)
  assert.equal((await f.call('ensure_claimed', { targetId: 'chrome:fixture' }, 'c')).success, true)
})

test('交还原生输入失败不谎报成功；重复 release 可只重试交还，不重放页面动作', async (t) => {
  let fail = true
  const f = fixture({
    onSessionReleased: async () => {
      if (fail) throw new Error('Input is still being released')
    },
  })
  t.after(() => f.executor.dispose())
  const a = first(await f.call('ensure_claimed', { targetId: 'chrome:fixture' }))
  assert.equal((await f.call('release', { tabId: a.tabId })).success, false)
  fail = false
  assert.equal((await f.call('release', { tabId: a.tabId })).success, true)
  assert.equal(f.calls.filter((op) => op === 'release').length, 1)
})

test('同会话还有另一张有效标签时不交还原生输入；人工登录暂停不因空闲回收', async (t) => {
  let now = 0
  const released: string[] = []
  const f = fixture({
    now: () => now,
    idleMs: 100,
    onSessionReleased: async (owner) => {
      released.push(owner.threadId)
    },
  })
  t.after(() => f.executor.dispose())
  f.duplicate()
  const tabs = first(await f.call('tabs', { action: 'list', targetId: 'chrome:fixture' })).tabs
  const a = first(await f.call('claim', { claimToken: tabs[0].claimToken })).tabId
  const b = first(await f.call('claim', { claimToken: tabs[1].claimToken })).tabId
  assert.equal((await f.call('release', { tabId: a })).success, true)
  assert.deepEqual(released, [])
  const page = f.executor.pages.get(b)
  assert.ok(page)
  page.paused = true
  now = 101
  await f.executor.collectIdle()
  assert.equal(page.valid, true)
  assert.deepEqual(released, [])
  page.paused = false
  await f.executor.collectIdle()
  assert.deepEqual(released, ['s'])
})

test('一次调用完成列举、认领、等待、快照；租约过期只恢复一次，不派发输入', async (t) => {
  const legacy = fixture()
  t.after(() => legacy.executor.dispose())
  const listing = first(await legacy.call('tabs', { action: 'list', targetId: 'chrome:fixture' }))
  const claimed = first(await legacy.call('claim', { claimToken: listing.tabs[0].claimToken }))
  assert.equal((await legacy.call('snapshot', { tabId: claimed.tabId })).success, true)
  assert.equal(legacy.modelCalls(), 3)
  const initialCalls = legacy.modelCalls()
  // 关闭新增自动恢复，按复盘中的旧编排重放：失败观察 → 列出 → 认领 → 快照。
  const oldPage = legacy.executor.pages.get(claimed.tabId)
  assert.ok(oldPage)
  oldPage.recoverable = false
  legacy.reconnect()
  assert.equal((await legacy.call('snapshot', { tabId: claimed.tabId })).success, false)
  const relisted = first(await legacy.call('tabs', { action: 'list', targetId: 'chrome:fixture' }))
  const reclaimed = first(await legacy.call('claim', { claimToken: relisted.tabs[0].claimToken }))
  assert.equal((await legacy.call('snapshot', { tabId: reclaimed.tabId })).success, true)
  const recoveryCalls = legacy.modelCalls() - initialCalls
  assert.equal(recoveryCalls, 4)
  const f = fixture()
  t.after(() => f.executor.dispose())
  const ready = await f.call('ensure_claimed', { targetId: 'chrome:fixture' })
  assert.equal(ready.success, true, text(ready))
  assert.equal(f.modelCalls(), 1)
  const tabId = first(ready).tabId
  f.expire()
  const recovered = await f.call('ensure_claimed', { tabId })
  assert.equal(recovered.success, true, text(recovered))
  assert.equal(first(recovered).tabId, tabId)
  assert.notEqual(ref(ready), ref(recovered))
  assert.equal(f.calls.filter((op) => op === 'claim').length, 2)
  assert.equal(
    f.calls.some((op) => ['navigate', 'history', 'show'].includes(op)),
    false,
  )
  console.log(
    JSON.stringify({
      fixture: 'initial-claim',
      beforeCalls: initialCalls,
      afterCalls: f.modelCalls() - 1,
      staleLeaseBeforeCalls: recoveryCalls,
      staleLeaseAfterCalls: 1,
    }),
  )
})

test('同一标签断线后的 snapshot 自动恢复；旧 ref 不复用', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const ready = await f.call('ensure_claimed', { targetId: 'chrome:fixture', url: f.tab.url })
  const tabId = first(ready).tabId
  f.reconnect()
  const snapshot = await f.call('snapshot', { tabId })
  assert.equal(snapshot.success, true, text(snapshot))
  assert.notEqual(ref(snapshot), ref(ready))
  await f.call('release', { tabId })
  const released = await f.call('snapshot', { tabId })
  assert.equal(released.success, false)
  assert.equal(first(released).recovery.needs_claim, true)
})

test('暂停登录、用户停止、站点拒绝和跨会话句柄都不自动恢复', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const ready = await f.call('ensure_claimed', { targetId: 'chrome:fixture' })
  const tabId = first(ready).tabId
  const page = f.executor.pages.get(tabId)!
  page.paused = true
  const before = f.calls.length
  const paused = await f.call('ensure_claimed', { tabId })
  assert.equal(first(paused).recovery.status, 'waiting_for_user')
  assert.equal(f.calls.length, before)
  page.paused = false
  f.instance.stopped = true
  assert.equal(first(await f.call('ensure_claimed', { tabId })).code, 'userStopped')
  f.instance.stopped = false
  assert.equal((await f.call('ensure_claimed', { tabId }, 'other')).success, false)
  const d = fixture()
  t.after(() => d.executor.dispose())
  d.deny()
  const denied = await d.call('ensure_claimed', { targetId: 'chrome:fixture' })
  assert.equal(first(denied).recovery.needs_approval, true)
  assert.deepEqual(d.calls, ['list'])
  const deniedAgain = await d.call('ensure_claimed', { targetId: 'chrome:fixture' })
  assert.equal(deniedAgain.success, false)
  assert.ok(!d.calls.includes('claim'))
})

test('目标不唯一时不猜测，不认领任意标签', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  f.duplicate()
  assert.equal((await f.call('ensure_claimed', { targetId: 'chrome:fixture' })).success, false)
  assert.deepEqual(f.calls, ['list'])
})

test('Chrome 重启重用数字 tabId 时不接管新标签', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const ready = await f.call('ensure_claimed', { targetId: 'chrome:fixture' })
  const tabId = first(ready).tabId
  f.reconnect()
  f.tab.targetId = 'another-document-target'
  const result = await f.call('snapshot', { tabId })
  assert.equal(result.success, false)
  assert.match(text(result), /original Chrome target cannot be verified/)
  assert.equal(f.calls.filter((op) => op === 'claim').length, 1)
})
