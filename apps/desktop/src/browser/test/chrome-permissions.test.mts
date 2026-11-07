import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChromeEvent } from '../../../../../packages/protocol/src/chrome-browser.mjs'
import { type ChromeBridge, ChromeBridgeError } from '../../chrome-browser/bridge.mjs'
import { ChromeExecutor } from '../../chrome-browser/executor.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../../client-tools/types.mjs'

const invocation: ClientToolInvocation = {
  id: 'call',
  callId: 'call',
  device: { id: 'local', kind: 'local', name: 'Test', target: null },
  threadId: 'thread',
  turnId: 'turn',
  namespace: 'litch_browser',
  tool: 'tabs',
  arguments: {},
  harness: null,
  cwd: null,
}
const text = (result: { contentItems: unknown[] }): string =>
  (result.contentItems[0] as { text: string }).text

function fixture(listedTabs?: unknown[]) {
  let enabled = true
  let seq = 0
  let failList = false
  const instance = { id: 'first', epoch: 'one', name: 'Chrome', stopped: false }
  const instances = [instance]
  const calls: string[] = []
  const asks: string[] = []
  let event: (id: string, event: ChromeEvent) => void = () => {}
  const tab = {
    id: 1,
    title: 'User tab',
    url: 'https://example.com',
    generation: 1,
    loading: false,
    origins: ['https://example.com'],
    busy: false,
  }
  const bridge = {
    instances: () => instances,
    onEvent: (receive: typeof event) => {
      event = receive
      return () => {}
    },
    call: async (_id: string, request: { op: string }) => {
      calls.push(request.op)
      if (request.op === 'list' && failList) {
        failList = false
        instance.epoch = 'reconnected'
        throw new ChromeBridgeError('staleLease', 'Chrome reconnected')
      }
      return request.op === 'list' ? (listedTabs ?? [tab]) : { tab }
    },
  } as unknown as ChromeBridge
  let executor = new ChromeExecutor({ bridge, allowed: () => enabled })
  const context: ClientToolContext = {
    signal: new AbortController().signal,
    ask: async (ask) => {
      asks.push(ask.kind)
      return 'session'
    },
  }
  const call = (tool: string, args: Record<string, unknown>, ctx = context, threadId = 'thread') =>
    executor.call({ ...invocation, threadId, tool, arguments: args, callId: `${++seq}` }, ctx)
  return {
    calls,
    asks,
    instance,
    context,
    call,
    list: () => call('tabs', { action: 'list', targetId: `chrome:${instance.id}` }),
    trust: () => executor.sites.setTrustAll(true),
    enable: (on: boolean) => {
      enabled = on
    },
    reconnect: () => {
      failList = true
    },
    stopped: (stopped: boolean) => {
      instance.stopped = stopped
      event(instance.id, { kind: 'control', stopped })
    },
    restart: () => {
      executor.dispose()
      executor = new ChromeExecutor({ bridge, allowed: () => enabled })
    },
    close: () => executor.dispose(),
  }
}

test('列表只标记最后获得焦点窗口的活动标签，保留原有字段', async () => {
  const tabs = [
    { active: false, lastFocusedWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true, lastFocusedWindow: false },
    { active: false, lastFocusedWindow: false },
    {},
  ].map((flags, id) => ({
    id,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    origins: ['https://example.com'],
    busy: id === 1,
    ...flags,
  }))
  const f = fixture(tabs)
  try {
    const result = await f.list()
    assert.equal(result.success, true)
    const listed = JSON.parse(text(result)).tabs
    assert.deepEqual(
      listed.map((tab: { current: boolean }) => tab.current),
      [false, true, false, false, false],
    )
    assert.equal(
      new Set(listed.map((tab: { claimToken: string }) => tab.claimToken)).size,
      tabs.length,
    )
    for (const [id, tab] of listed.entries()) {
      const original = tabs[id]
      assert.ok(original)
      assert.equal(typeof tab.claimToken, 'string')
      assert.deepEqual(tab, {
        title: original.title,
        url: original.url,
        claimToken: tab.claimToken,
        busy: original.busy,
        origins: original.origins,
        current: id === 1,
      })
    }
    assert.deepEqual(f.calls, ['list'])
    assert.deepEqual(f.asks, [])
  } finally {
    f.close()
  }
})

test('总开关关时不读 Chrome；开启后跨会话、扩展编号、代次、桌面重启都不弹实例或标签卡', async () => {
  const f = fixture()
  try {
    f.enable(false)
    assert.equal((await f.list()).success, false)
    assert.deepEqual(f.calls, [])
    f.enable(true)
    for (let i = 0; i < 3; i++) {
      f.trust()
      const listed = await f.list()
      assert.equal(listed.success, true)
      const token = JSON.parse(text(listed)).tabs[0].claimToken
      assert.equal((await f.call('claim', { claimToken: token })).success, true)
      assert.equal(
        (
          await f.call(
            'tabs',
            { action: 'list', targetId: `chrome:${f.instance.id}` },
            f.context,
            'other',
          )
        ).success,
        true,
      )
      f.restart()
      f.instance.id = `extension-${i}`
      f.instance.epoch = `epoch-${i}`
    }
    assert.deepEqual(f.asks, [])
  } finally {
    f.close()
  }
})

test('等网站审批超过 30 秒不发桥请求，不因 claimToken 的 30 秒期限失效', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const f = fixture()
  try {
    const listed = await f.list()
    const token = JSON.parse(text(listed)).tabs[0].claimToken
    let answer!: (value: 'session') => void
    const pending = f.call(
      'claim',
      { claimToken: token },
      {
        ...f.context,
        ask: async (ask) => {
          assert.equal(ask.kind, 'site')
          return new Promise((resolve) => {
            answer = resolve
          })
        },
      },
    )
    await Promise.resolve()
    assert.deepEqual(f.calls, ['list'])
    t.mock.timers.tick(125_000)
    assert.deepEqual(f.calls, ['list'])
    answer('session')
    assert.equal((await pending).success, true)
    assert.deepEqual(f.calls, ['list', 'claim'])
  } finally {
    f.close()
  }
})

test('网站审批中关掉总开关，迟到批准不得执行', async () => {
  const f = fixture()
  try {
    const token = JSON.parse(text(await f.list())).tabs[0].claimToken
    const result = await f.call(
      'claim',
      { claimToken: token },
      {
        ...f.context,
        ask: async () => {
          f.enable(false)
          return 'session'
        },
      },
    )
    assert.equal(result.success, false)
    assert.match(text(result), /disabled.*approval/)
    assert.deepEqual(f.calls, ['list'])
  } finally {
    f.close()
  }
})

test('用户停止后明确提示，重启和下一回合不会恢复；用户手动开启才可列出', async () => {
  const f = fixture()
  try {
    f.trust()
    f.stopped(true)
    f.restart()
    const result = await f.list()
    assert.equal(result.success, false)
    assert.match(text(result), /userStopped.*click the Litch extension to resume/)
    assert.deepEqual(f.calls, [])
    f.stopped(false)
    assert.equal((await f.list()).success, true)
    assert.deepEqual(f.asks, [])
  } finally {
    f.close()
  }
})

test('列标签恰逢同实例重连时自动重试一次；旧实例明确要求重新列 targets', async () => {
  const f = fixture()
  try {
    f.reconnect()
    assert.equal((await f.list()).success, true)
    assert.deepEqual(f.calls, ['list', 'list'])
    const result = await f.call('tabs', { action: 'list', targetId: 'chrome:removed' })
    assert.equal(result.success, false)
    assert.match(text(result), /disconnected.*List targets again/)
    assert.deepEqual(f.calls, ['list', 'list'])
  } finally {
    f.close()
  }
})
