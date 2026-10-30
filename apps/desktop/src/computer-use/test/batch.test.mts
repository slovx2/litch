// 桩助手覆盖批量编排；原生让行和窗口检查仍由 Swift/Rust 的原有测试守住。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computerToolsSpec } from '../../../../../packages/protocol/src/client-tools-computer.mjs'
import {
  clientToolNamespaces,
  pickClientToolExecutor,
} from '../../../../../packages/shared/src/client-tool-executor.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../../client-tools/types.mjs'
import { runComputerActions } from '../batch.mjs'
import { createComputerExecutor, type HelperRequester } from '../executor.mjs'
import { HelperError } from '../wire.mjs'

const app = 'com.apple.TextEdit'
const action = (tool = 'press_key', arguments_: Record<string, unknown> = { key: 'cmd+b' }) => ({
  tool,
  arguments: { app, ...arguments_ },
})
const call = (actions: unknown): ClientToolInvocation => ({
  id: 'batch-1',
  callId: 'batch-1',
  namespace: 'litch_computer',
  tool: 'run_actions',
  arguments: { actions },
  threadId: 'thread',
  turnId: 'turn',
  harness: 'codex',
  cwd: null,
  device: { id: 'local', name: 'local', kind: 'local', target: null },
})
const context = (): ClientToolContext => ({
  signal: new AbortController().signal,
  ask: async () => {
    throw new Error('没有逐应用审批')
  },
})
function rig(failAt = 0, kind: ConstructorParameters<typeof HelperError>[0] = 'stale') {
  const methods: string[] = []
  const params: Record<string, unknown>[] = []
  let count = 0
  const requester: HelperRequester = {
    async request(method, args = {}) {
      methods.push(method)
      params.push(args)
      if (method === 'permissions') return { accessibility: true, screenRecording: true }
      if (method === 'getAppState')
        return {
          app: { name: 'TextEdit', bundleId: app },
          window: { title: 'new' },
          text: '[9] TextField "current"',
          diff: false,
          screenshot: { width: 100, height: 100, mime: 'image/jpeg', data: 'QUJD' },
        }
      count += 1
      if (count === failAt)
        throw new HelperError(kind, `${kind}: call get_app_state before continuing`)
      return { text: `done ${method}\n\nintermediate tree` }
    },
  }
  const executor = createComputerExecutor({
    helper: { client: async () => requester, restart: async () => {}, connected: requester },
  })
  return { executor, methods, params }
}
const textOf = (value: Awaited<ReturnType<ReturnType<typeof rig>['executor']['call']>>) =>
  value.contentItems.flatMap((item) => (item.type === 'inputText' ? [item.text] : [])).join('\n')

test('顺序执行，每步查权限，最终只观察一次并给全文、最多一张图', async () => {
  const { executor, methods, params } = rig()
  const result = await executor.call(
    call([
      action('select_text', { element: 3, text: 'second' }),
      action(),
      action('press_key', { key: 'cmd+s' }),
    ]),
    context(),
  )
  assert.equal(result.success, true)
  assert.deepEqual(methods, [
    'permissions',
    'selectText',
    'permissions',
    'pressKey',
    'permissions',
    'pressKey',
    'permissions',
    'getAppState',
  ])
  assert.equal(params.at(-1)?.full, true)
  assert.equal(result.contentItems.filter((item) => item.type === 'inputImage').length, 1)
  assert.doesNotMatch(textOf(result), /intermediate tree/)
  assert.match(textOf(result), /1\. select_text/)
  assert.match(textOf(result), /\[9\]/)
})

for (const kind of ['stale', 'userActive', 'stopped', 'permission', 'failed'] as const) {
  test(`${kind} 在第二步停止，不执行第三步，保留原因并返回当前状态`, async () => {
    const { executor, methods } = rig(2, kind)
    const result = await executor.call(
      call([action(), action('click', { element: 4 }), action('type_text', { text: 'never' })]),
      context(),
    )
    assert.equal(result.success, false)
    assert.equal(methods.includes('typeText'), false)
    assert.match(textOf(result), /Stopped at step 2/)
    assert.match(textOf(result), kind === 'permission' ? /permission/i : new RegExp(kind))
    assert.match(textOf(result), /Do not replay/)
  })
}

test('权限在批内丢失时阻止下一步及最终观察，不补授权、不自动重试', async () => {
  let checks = 0,
    inputs = 0
  const requester: HelperRequester = {
    async request(method) {
      if (method === 'permissions') return { accessibility: ++checks === 1, screenRecording: true }
      inputs++
      return { text: 'done' }
    },
  }
  const executor = createComputerExecutor({
    now: () => 1,
    helper: {
      client: async () => requester,
      connected: requester,
      restart: async () => {
        throw new Error('不应重启')
      },
    },
  })
  const result = await executor.call(call([action(), action()]), context())
  assert.equal(inputs, 1)
  assert.equal(result.success, false)
  assert.match(textOf(result), /Accessibility/)
})

test('整批预检：空列表、过量、嵌套、观察、无应用均不执行', async () => {
  for (const actions of [
    [],
    Array.from({ length: 13 }, () => action()),
    [action(), action('run_actions')],
    [action('get_app_state')],
    [{ tool: 'click', arguments: {} }],
  ]) {
    const { executor, methods } = rig()
    assert.equal((await executor.call(call(actions), context())).success, false)
    assert.deepEqual(methods, [])
  }
  const { executor } = rig()
  assert.equal(
    (await executor.call(call(Array.from({ length: 12 }, () => action())), context())).success,
    true,
  )
})

test('取消后不执行下一步，也不再观察', async () => {
  const controller = new AbortController()
  const seen: string[] = []
  const result = await runComputerActions(
    call([action(), action()]),
    { ...context(), signal: controller.signal },
    async (one) => {
      seen.push(one.tool)
      controller.abort()
      return { success: true, contentItems: [{ type: 'inputText', text: 'partly done' }] }
    },
  )
  assert.equal(result.success, false)
  assert.deepEqual(seen, ['press_key'])
  assert.match(textOf(result), /Current state unavailable/)
})

test('动作共用期限，到期取消当步；最终观察另有限时', async () => {
  const seen: string[] = []
  const result = await runComputerActions(
    call([action(), action()]),
    context(),
    async (one, ctx) => {
      seen.push(one.tool)
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return { success: false, contentItems: [{ type: 'inputText', text: 'cancelled' }] }
    },
    { actionMs: 10, stateMs: 10 },
  )
  assert.deepEqual(seen, ['press_key', 'get_app_state'])
  assert.equal(result.success, false)
  assert.match(textOf(result), /batch time limit/)
})

test('新工具显式挂载，子动作 schema 与离散工具完全相同', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const original = computerToolsSpec(platform)
    const batch = computerToolsSpec(platform, true)
    assert.deepEqual(batch.tools.slice(0, -1), original.tools)
    const props = batch.tools.at(-1)?.inputSchema.properties as {
      actions: {
        items: { oneOf: { properties: { tool: { enum: string[] }; arguments: unknown } }[] }
      }
    }
    for (const choice of props.actions.items.oneOf) {
      assert.deepEqual(
        choice.properties.arguments,
        original.tools.find((one) => one.name === choice.properties.tool.enum[0])?.inputSchema,
      )
    }
  }
})

test('助手启动不响应取消时，仍按总时限结束，不提交第二步', async () => {
  const seen: string[] = []
  const result = await runComputerActions(
    call([action(), action()]),
    context(),
    async (one) => {
      seen.push(one.tool)
      return new Promise(() => {})
    },
    { actionMs: 10, stateMs: 10 },
  )
  assert.equal(result.success, false)
  assert.deepEqual(seen, ['press_key', 'get_app_state'])
})

test('新声明只对同时声明扩展、命名空间的连接有效；所有路由角色拒绝旧连接的批量', () => {
  const declaration = (extension: boolean, namespaces: string[], computerActions: unknown) =>
    clientToolNamespaces({
      capabilities: {
        litchExtensions: extension ? ['clientTools'] : [],
        litchClientTools: { namespaces, anyThread: namespaces, computerActions },
      },
    })
  const old = declaration(true, ['litch_computer'], false)
  const fresh = declaration(true, ['litch_computer'], true)
  for (const denied of [
    old,
    declaration(false, ['litch_computer'], true),
    declaration(true, [], true),
    declaration(true, ['litch_computer'], 'true'),
  ]) {
    assert.equal(
      pickClientToolExecutor(
        'litch_computer',
        denied,
        [denied],
        (one) => one,
        [denied],
        'run_actions',
      ),
      null,
    )
  }
  assert.equal(
    pickClientToolExecutor('litch_computer', old, [fresh], (one) => one, [], 'run_actions'),
    fresh,
  )
  assert.equal(
    pickClientToolExecutor('litch_computer', old, [fresh], (one) => one, [], 'click'),
    old,
  )
})
