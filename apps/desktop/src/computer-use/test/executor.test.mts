// litch_computer 执行器的单元测试：助手用桩，不起真的进程、不碰系统权限。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  ClientToolAnswer,
  ClientToolAsk,
  ClientToolContext,
  ClientToolInvocation,
} from '../../client-tools/types.mjs'
import { createComputerExecutor, type HelperAccess, type HelperRequester } from '../executor.mjs'
import { type HelperApp, HelperError } from '../wire.mjs'

// 文本编辑按中文系统的样子给：显示名是本地化的，模型叫它 TextEdit（包的文件名）也要找得到
const APPS: HelperApp[] = [
  {
    name: '文本编辑',
    fileName: 'TextEdit',
    bundleId: 'com.apple.TextEdit',
    pid: 11,
    active: true,
    windows: 1,
  },
  {
    name: 'Safari',
    fileName: 'Safari',
    bundleId: 'com.apple.Safari',
    pid: 12,
    active: false,
    windows: 2,
  },
  {
    name: '1Password',
    fileName: '1Password',
    bundleId: 'com.1password.1password',
    pid: 13,
    active: false,
    windows: 1,
  },
  {
    name: 'Litch',
    fileName: 'Litch',
    bundleId: 'io.github.slovx2.litch',
    pid: 14,
    active: false,
    windows: 1,
  },
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
      if (params.app === 'Nope')
        throw new HelperError('notFound', 'No running app matches Nope. Call list_apps.')
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

test('list_apps 不查权限，所有应用照常列出', async () => {
  const helper = fakeHelper()
  helper.setPermissions({ accessibility: false, screenRecording: false })
  const executor = createComputerExecutor({ helper: helper.access })
  const { ctx } = context()
  const response = await executor.call(invocation('list_apps', {}), ctx)
  assert.equal(response.success, true)
  assert.match(textOf(response), /文本编辑 \(TextEdit\) — com\.apple\.TextEdit \(frontmost\)/)
  assert.match(textOf(response), /- Safari — com\.apple\.Safari\n/)
  assert.match(textOf(response), /- 1Password — com\.1password\.1password\n/)
  assert.doesNotMatch(textOf(response), /not allowed/)
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
    now: () => clock,
  })
  const { ctx, asks } = context()
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

test('任何应用都直接交给助手，不问用户：浏览器、密码管理器、Litch 自己都一样', async () => {
  for (const app of ['safari', '1Password', 'io.github.slovx2.litch']) {
    const helper = fakeHelper()
    const executor = createComputerExecutor({ helper: helper.access })
    const { ctx, asks } = context()
    const request = invocation('click', { app, element: 2 })
    const response = await executor.call(request, ctx)
    assert.equal(response.success, true, app)
    assert.equal(asks.length, 0)
    // 助手负责名字解析；主进程不重复枚举全部窗口
    const click = helper.calls.find((call) => call.method === 'click')
    assert.deepEqual(click?.params, {
      app,
      element: 2,
      session: 'local/thread-1',
      turnId: request.turnId,
      actionId: request.id,
    })
  }
})

test('远程设备的会话也不问', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({ helper: helper.access })
  const remote = { id: 'box', name: 'Build box', kind: 'ssh' as const, target: 'box' }
  const { ctx, asks } = context()
  const request = invocation('press_key', { app: 'TextEdit', key: 'cmd+s' }, remote)
  const response = await executor.call(request, ctx)
  assert.equal(response.success, true)
  assert.equal(asks.length, 0)
  const press = helper.calls.find((call) => call.method === 'pressKey')
  assert.deepEqual(press?.params, {
    app: 'TextEdit',
    key: 'cmd+s',
    session: 'box/thread-1',
    turnId: request.turnId,
    actionId: request.id,
  })
})

test('get_app_state：文字加截图（data: 地址）', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({ helper: helper.access })
  const { ctx } = context()
  const request = invocation('get_app_state', { app: 'TextEdit', full: true })
  const response = await executor.call(request, ctx)
  assert.equal(response.success, true)
  assert.deepEqual(
    helper.calls.map((call) => call.method),
    ['permissions', 'getAppState'],
  )
  assert.equal(response.contentItems.length, 2)
  assert.match(textOf(response), /Screenshot: 1200x800 pixels/)
  assert.match(textOf(response), /\[2\] TextArea/)
  assert.deepEqual(response.contentItems[1], {
    type: 'inputImage',
    imageUrl: 'data:image/jpeg;base64,QUJD',
  })
  const call = helper.calls.find((one) => one.method === 'getAppState')
  assert.deepEqual(call?.params, {
    app: 'TextEdit',
    full: true,
    session: 'local/thread-1',
    turnId: request.turnId,
    actionId: request.id,
  })
})

test('应用清单包含没有可见窗口的应用', async () => {
  const helper = fakeHelper({ listApps: () => ({ apps: [{ ...APPS[0], windows: 0 }] }) })
  const executor = createComputerExecutor({ helper: helper.access })
  const result = await executor.call(invocation('list_apps', {}), context().ctx)
  assert.match(textOf(result), /TextEdit.*no visible windows/)
})

test('无窗口应用返回菜单和下一步，仍可直接发送新建快捷键，不伪造截图', async () => {
  const helper = fakeHelper({
    getAppState: () => ({
      windowless: true,
      app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 11 },
      accessibleWindow: null,
      visibleWindows: 0,
      frontmost: 'Finder',
      menuAvailable: true,
      text: '[1] MenuBar\n [2] MenuBarItem "File"',
      diff: false,
      truncated: false,
    }),
  })
  const executor = createComputerExecutor({ helper: helper.access })
  const { ctx } = context()
  const state = await executor.call(invocation('get_app_state', { app: 'TextEdit' }), ctx)
  assert.equal(state.success, true)
  assert.equal(state.contentItems.length, 1)
  assert.match(textOf(state), /Visible windows: 0/)
  assert.match(textOf(state), /foreground app: Finder/)
  assert.match(textOf(state), /cmd\+n/)
  assert.match(textOf(state), /MenuBarItem/)
  const action = await executor.call(
    invocation('press_key', { app: 'TextEdit', key: 'cmd+n' }),
    ctx,
  )
  assert.equal(action.success, true)
  assert.equal(helper.calls.at(-1)?.method, 'pressKey')
})

test('助手的错误分类转成失败答复', async () => {
  const cases: [string, RegExp][] = [
    ['stopped', /^\[litch:failed\] stopped by user/],
    ['userActive', /^\[litch:failed\] stopped by user/],
    ['invalid', /^\[litch:invalid\] stopped by user/],
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
    })
    const { ctx } = context()
    const response = await executor.call(invocation('click', { app: 'TextEdit', element: 1 }), ctx)
    assert.equal(response.success, false)
    assert.match(textOf(response), expected, kind)
  }
})

test('参数不对、工具不认识、应用没在跑', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({ helper: helper.access })
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
  const executor = createComputerExecutor({ helper: helper.access })
  const { ctx, controller } = context()
  controller.abort()
  const response = await executor.call(invocation('list_apps', {}), ctx)
  assert.match(textOf(response), /^\[litch:failed\] The call was cancelled/)
})

test('回合结束：告诉助手撤提示、清这个会话', async () => {
  const helper = fakeHelper()
  const executor = createComputerExecutor({ helper: helper.access })
  executor.turnEnded?.({ deviceId: 'box', threadId: 't7', turnId: 'u1' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(helper.calls, [
    { method: 'turnEnded', params: { session: 'box/t7', turnId: 'u1' } },
  ])
})
