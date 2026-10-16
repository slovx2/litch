// litch_computer 执行器的单元测试：助手用桩，不起真的进程、不碰系统权限。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type {
  ClientToolAnswer,
  ClientToolAsk,
  ClientToolContext,
  ClientToolInvocation,
} from '../../client-tools/types.mjs'
import { APPROVALS_FILE, ApprovalStore } from '../approvals.mjs'
import { createComputerExecutor, type HelperAccess, type HelperRequester } from '../executor.mjs'
import { type HelperApp, HelperError } from '../wire.mjs'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'litch-cu-test-'))
  dirs.push(dir)
  return dir
}

const APPS: HelperApp[] = [
  { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 11, active: true, windows: 1 },
  { name: 'Safari', bundleId: 'com.apple.Safari', pid: 12, active: false, windows: 2 },
  { name: '1Password', bundleId: 'com.1password.1password', pid: 13, active: false, windows: 1 },
  { name: 'Litch', bundleId: 'io.github.slovx2.litch', pid: 14, active: false, windows: 1 },
]

interface Call {
  method: string
  params: Record<string, unknown>
}

/** 桩助手：记下每次请求，按方法回预设的结果 */
function fakeHelper(
  overrides: Partial<Record<string, (params: Record<string, unknown>) => unknown>> = {},
) {
  const calls: Call[] = []
  let restarts = 0
  let permissions = { accessibility: true, screenRecording: true }
  const requester: HelperRequester = {
    async request(method, params = {}, _timeout, signal) {
      calls.push({ method, params })
      if (signal?.aborted) throw new HelperError('failed', 'cancelled')
      const override = overrides[method]
      if (override) return override(params)
      switch (method) {
        case 'permissions':
          return permissions
        case 'listApps':
          return { apps: APPS }
        case 'getAppState':
          return {
            app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 11 },
            window: { title: 'Untitled', width: 600, height: 400 },
            screenshot: { mime: 'image/jpeg', data: 'QUJD', width: 1200, height: 800 },
            text: '[1] Window "Untitled"\n  [2] TextArea = ""',
            diff: false,
            truncated: false,
          }
        default:
          return { text: `did ${method}` }
      }
    },
  }
  const access: HelperAccess = {
    client: async () => requester,
    restart: async () => {
      restarts += 1
    },
    get connected() {
      return requester
    },
  }
  return {
    access,
    calls,
    get restarts() {
      return restarts
    },
    setPermissions(next: typeof permissions) {
      permissions = next
    },
  }
}

function invocation(
  tool: string,
  args: unknown,
  device: Partial<ClientToolInvocation['device']> = {},
  threadId = 'thread-1',
): ClientToolInvocation {
  return {
    id: `call-${Math.random()}`,
    threadId,
    turnId: 'turn-1',
    callId: 'c1',
    namespace: 'litch_computer',
    tool,
    arguments: args,
    device: { id: 'local', name: 'This Mac', kind: 'local', target: null, ...device },
    harness: 'codex',
    cwd: null,
  }
}

function context(answers: (ClientToolAnswer | null)[] = []) {
  const asks: ClientToolAsk[] = []
  const controller = new AbortController()
  const ctx: ClientToolContext = {
    signal: controller.signal,
    ask: async (ask) => {
      asks.push(ask)
      return answers.length > 0 ? (answers.shift() ?? null) : null
    },
  }
  return { ctx, asks, controller }
}

function textOf(response: { contentItems: { type: string; text?: string }[] }): string {
  return response.contentItems
    .filter((item) => item.type === 'inputText')
    .map((item) => item.text)
    .join('\n')
}

test('list_apps 不查权限，禁止的应用标出来', async () => {
  const helper = fakeHelper()
  helper.setPermissions({ accessibility: false, screenRecording: false })
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  const { ctx } = context()
  const response = await executor.call(invocation('list_apps', {}), ctx)
  assert.equal(response.success, true)
  assert.match(textOf(response), /TextEdit — com\.apple\.TextEdit \(frontmost\)/)
  assert.match(textOf(response), /1Password — com\.1password\.1password \(not allowed\)/)
  assert.deepEqual(
    helper.calls.map((call) => call.method),
    ['listApps'],
  )
})

test('没有权限：重启一次助手再查，还没有就回 permission，不弹卡片', async () => {
  const helper = fakeHelper()
  helper.setPermissions({ accessibility: true, screenRecording: false })
  let clock = 100_000
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
    now: () => clock,
  })
  const { ctx, asks } = context(['session'])
  const response = await executor.call(invocation('get_app_state', { app: 'TextEdit' }), ctx)
  assert.equal(response.success, false)
  assert.match(textOf(response), /^\[litch:permission\] /)
  assert.match(textOf(response), /Screen Recording/)
  assert.doesNotMatch(textOf(response), /Accessibility and/)
  assert.equal(helper.restarts, 1)
  assert.equal(asks.length, 0)
  // 30 秒之内再来不再重启
  clock += 10_000
  await executor.call(invocation('get_app_state', { app: 'TextEdit' }), ctx)
  assert.equal(helper.restarts, 1)
  clock += 30_001
  await executor.call(invocation('get_app_state', { app: 'TextEdit' }), ctx)
  assert.equal(helper.restarts, 2)
})

test('禁止的应用当场 declined，不问用户，也不交给助手', async () => {
  for (const app of ['1Password', 'io.github.slovx2.litch']) {
    const helper = fakeHelper()
    const executor = createComputerExecutor({
      helper: helper.access,
      store: new ApprovalStore(tempDir()),
    })
    const { ctx, asks } = context(['always'])
    const response = await executor.call(invocation('click', { app, element: 3 }), ctx)
    assert.equal(response.success, false)
    assert.match(textOf(response), /^\[litch:declined\] /)
    assert.equal(asks.length, 0)
    assert.equal(
      helper.calls.some((call) => call.method === 'click'),
      false,
    )
  }
})

test('首次操作要问；本会话允许之后同一会话不再问，别的会话还要问；高风险标出来', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  const first = context(['session'])
  const ok = await executor.call(invocation('click', { app: 'safari', element: 2 }), first.ctx)
  assert.equal(ok.success, true)
  assert.deepEqual(first.asks, [
    {
      kind: 'app',
      app: { name: 'Safari', bundleId: 'com.apple.Safari' },
      risk: 'elevated',
      allowAlways: true,
    },
  ])
  // 交给助手的是包标识（模型给的别名不往下传）和会话键
  const click = helper.calls.find((call) => call.method === 'click')
  assert.deepEqual(click?.params, {
    app: 'com.apple.Safari',
    element: 2,
    session: 'local/thread-1',
  })

  const again = context()
  await executor.call(invocation('click', { app: 'com.apple.Safari', element: 2 }), again.ctx)
  assert.equal(again.asks.length, 0)

  const other = context(['once'])
  await executor.call(invocation('click', { app: 'Safari', element: 2 }, {}, 'thread-2'), other.ctx)
  assert.equal(other.asks.length, 1)
  // “仅这一次”不记
  const third = context(['decline'])
  const declined = await executor.call(
    invocation('click', { app: 'Safari', element: 2 }, {}, 'thread-2'),
    third.ctx,
  )
  assert.equal(third.asks.length, 1)
  assert.match(textOf(declined), /^\[litch:declined\] /)
})

test('始终允许：存进用户数据目录，换一个会话、重开执行器都不再问；删掉后又问', async () => {
  const userData = tempDir()
  const helper = fakeHelper()
  const store = new ApprovalStore(userData)
  const executor = createComputerExecutor({ helper: helper.access, store })
  const first = context(['always'])
  await executor.call(invocation('type_text', { app: 'TextEdit', text: 'hi' }), first.ctx)
  assert.equal(first.asks.length, 1)
  const saved = JSON.parse(readFileSync(join(userData, APPROVALS_FILE), 'utf8'))
  assert.equal(saved.apps[0].bundleId, 'com.apple.TextEdit')

  const reopened = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(userData),
  })
  const second = context()
  const response = await reopened.call(
    invocation('type_text', { app: 'TextEdit', text: 'hi' }, {}, 'thread-9'),
    second.ctx,
  )
  assert.equal(response.success, true)
  assert.equal(second.asks.length, 0)

  assert.equal(store.remove('com.apple.TextEdit'), true)
  assert.deepEqual(store.list(), [])
  const fresh = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(userData),
  })
  const third = context(['session'])
  await fresh.call(
    invocation('type_text', { app: 'TextEdit', text: 'hi' }, {}, 'thread-10'),
    third.ctx,
  )
  assert.equal(third.asks.length, 1)
})

test('远程设备的会话：没有“始终允许”，已存的始终允许也不算', async () => {
  const userData = tempDir()
  const store = new ApprovalStore(userData)
  store.addAlways({ bundleId: 'com.apple.TextEdit', name: 'TextEdit' })
  const helper = fakeHelper()
  const executor = createComputerExecutor({ helper: helper.access, store })
  const remote = { id: 'box', name: 'Build box', kind: 'ssh' as const, target: 'box' }
  const first = context(['always'])
  const response = await executor.call(
    invocation('press_key', { app: 'TextEdit', key: 'cmd+s' }, remote),
    first.ctx,
  )
  assert.equal(response.success, true)
  assert.equal(first.asks.length, 1)
  assert.equal(first.asks[0]?.kind === 'app' && first.asks[0].allowAlways, false)
  // 选了 always 也只当本会话，不写进清单
  assert.deepEqual(
    store.list().map((one) => one.bundleId),
    ['com.apple.TextEdit'],
  )
  assert.equal(store.list().length, 1)
  // 同一会话不再问，另一个远程会话还要问
  const same = context()
  await executor.call(invocation('press_key', { app: 'TextEdit', key: 'a' }, remote), same.ctx)
  assert.equal(same.asks.length, 0)
  const other = context(['session'])
  await executor.call(
    invocation('press_key', { app: 'TextEdit', key: 'a' }, remote, 'thread-2'),
    other.ctx,
  )
  assert.equal(other.asks.length, 1)
})

test('卡片被取消（没答）回 failed', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  const { ctx } = context([null])
  const response = await executor.call(invocation('click', { app: 'TextEdit', x: 1, y: 2 }), ctx)
  assert.match(textOf(response), /^\[litch:failed\] The approval request was cancelled/)
})

test('get_app_state：文字加截图（data: 地址）', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  const { ctx } = context(['session'])
  const response = await executor.call(
    invocation('get_app_state', { app: 'TextEdit', full: true }),
    ctx,
  )
  assert.equal(response.success, true)
  assert.equal(response.contentItems.length, 2)
  assert.match(textOf(response), /Screenshot: 1200x800 pixels/)
  assert.match(textOf(response), /\[2\] TextArea/)
  assert.deepEqual(response.contentItems[1], {
    type: 'inputImage',
    imageUrl: 'data:image/jpeg;base64,QUJD',
  })
  const call = helper.calls.find((one) => one.method === 'getAppState')
  assert.deepEqual(call?.params, {
    app: 'com.apple.TextEdit',
    full: true,
    session: 'local/thread-1',
  })
})

test('助手的错误分类转成失败答复', async () => {
  const cases: [string, RegExp][] = [
    ['stopped', /^\[litch:failed\] stopped by user/],
    ['userActive', /^\[litch:failed\] stopped by user/],
    ['invalid', /^\[litch:invalid\] stopped by user/],
    ['forbidden', /^\[litch:declined\] stopped by user/],
    ['permission', /^\[litch:permission\] /],
  ]
  for (const [kind, expected] of cases) {
    const helper = fakeHelper({
      click: () => {
        throw new HelperError(kind as never, 'stopped by user')
      },
    })
    const executor = createComputerExecutor({
      helper: helper.access,
      store: new ApprovalStore(tempDir()),
    })
    const { ctx } = context(['session'])
    const response = await executor.call(invocation('click', { app: 'TextEdit', element: 1 }), ctx)
    assert.equal(response.success, false)
    assert.match(textOf(response), expected, kind)
  }
})

test('参数不对、工具不认识、应用没在跑', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  const { ctx } = context()
  assert.match(textOf(await executor.call(invocation('click', 'oops'), ctx)), /^\[litch:invalid\]/)
  assert.match(
    textOf(await executor.call(invocation('fly', { app: 'x' }), ctx)),
    /^\[litch:invalid\] Unknown tool/,
  )
  assert.match(
    textOf(await executor.call(invocation('click', {}), ctx)),
    /^\[litch:invalid\] app is required/,
  )
  assert.match(
    textOf(await executor.call(invocation('click', { app: 'Nope' }), ctx)),
    /^\[litch:failed\] No running app/,
  )
})

test('被打断：回 failed', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  const { ctx, controller } = context()
  controller.abort()
  const response = await executor.call(invocation('list_apps', {}), ctx)
  assert.match(textOf(response), /^\[litch:failed\] The call was cancelled/)
})

test('回合结束：告诉助手撤提示、清这个会话', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({
    helper: helper.access,
    store: new ApprovalStore(tempDir()),
  })
  executor.turnEnded?.({ deviceId: 'box', threadId: 't7', turnId: 'u1' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(helper.calls, [{ method: 'turnEnded', params: { session: 'box/t7' } }])
})
