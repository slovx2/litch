import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computerToolsSpec } from '../../automation-contracts/src/litch/client-tools-computer.mjs'
import { portableComputerTools } from '../../automation-contracts/src/litch/client-tools-computer-portable.mjs'
import type { InvocationContext, ToolInvocation } from '../../automation-contracts/src/runtime.mjs'
import { createComputerUse, type HelperRequester } from '../src/index.mjs'
import { computerTools } from '../src/tools.mjs'

const scope = { hostId: 'host-a', deviceId: 'device-a', sessionId: 's', turnId: 't', callId: 'c' }
const call = (tool = 'click'): ToolInvocation => ({
  scope,
  namespace: 'test_computer',
  tool,
  arguments: { app: 'fixture', x: 1, y: 1 },
})
function fixture() {
  const requests: { method: string; params: Record<string, unknown> }[] = []
  let disposed = 0
  let approved = 0
  const helper: HelperRequester = {
    async request(method, params = {}) {
      requests.push({ method, params })
      if (method === 'permissions') return { accessibility: true, screenRecording: true }
      if (method === 'inspectTarget') return { self: true, pid: 123 }
      if (method === 'listApps') return { apps: [] }
      if (method === 'getAppState')
        return {
          app: { name: 'Litch window text must remain literal', bundleId: 'fixture' },
          window: { title: 'Litch' },
          screenshot: { width: 10, height: 10, mime: 'image/png', data: 'YWJj' },
          text: 'Litch user content',
          diff: false,
        }
      return { text: 'done' }
    },
  }
  const runtime = createComputerUse({
    hostId: scope.hostId,
    namespace: 'test_computer',
    productName: 'Test Host',
    helperName: 'Test Helper',
    platform: 'darwin',
    batch: true,
    helper: { client: async () => helper, connected: helper, restart: async () => {} },
    disposeHelper: async () => {
      disposed++
    },
  })
  const context: InvocationContext = {
    signal: new AbortController().signal,
    hold: () => () => {},
    approvals: {
      async request(request) {
        approved++
        return {
          requestId: request.id,
          nonce: request.nonce,
          scope: request.scope,
          decision: 'once',
        }
      },
      dismiss: async () => {},
    },
  }
  return { runtime, context, requests, approved: () => approved, disposed: () => disposed }
}

test('工具定义的 Litch 配置与 M2 唯一源逐字段一致', () => {
  for (const platform of ['darwin', 'win32'] as const)
    for (const batch of [false, true]) {
      assert.deepEqual(
        computerTools({
          productName: 'Litch',
          helperName: 'Litch Computer Use',
          namespace: 'litch_computer',
          platform,
          batch,
        }),
        computerToolsSpec(platform, batch),
      )
    }
  assert.deepEqual(
    computerTools({
      productName: 'Litch',
      helperName: 'Litch Computer Use',
      namespace: 'litch_computer',
      platform: 'portable',
      batch: true,
    }),
    portableComputerTools(),
  )
  const other = computerTools({
    productName: 'Other',
    helperName: 'Other Helper',
    namespace: 'other_computer',
    platform: 'win32',
    batch: true,
  })
  assert.equal(other.name, 'other_computer')
  assert.ok(!JSON.stringify(other).includes('Litch'))
})

test('宿主来源隔离、真实目标检查及审批绑定；模型不能注入 selfAllowed', async () => {
  const f = fixture()
  assert.equal(
    (
      await f.runtime.executor.execute(
        { ...call(), scope: { ...scope, hostId: 'other' } },
        f.context,
      )
    ).success,
    false,
  )
  assert.equal(f.requests.length, 0)
  const input = { ...call(), arguments: { app: 'fixture', selfAllowed: true, targetPid: 999 } }
  f.context.approvals.request = async (request) => ({
    requestId: request.id,
    nonce: request.nonce,
    scope: { ...scope, callId: 'wrong' },
    decision: 'always',
  })
  assert.equal((await f.runtime.executor.execute(input, f.context)).success, false)
  assert.equal(f.requests.filter((item) => item.method === 'click').length, 0)
  f.context.approvals.request = async (request) => ({
    requestId: request.id,
    nonce: request.nonce,
    scope: request.scope,
    decision: 'once',
  })
  assert.equal((await f.runtime.executor.execute(input, f.context)).success, true)
  assert.equal(f.requests.find((item) => item.method === 'click')?.params.targetPid, 123)
  await f.runtime.dispose()
})

test('结束回合取消审批、撤卡并发送单个收尾帧；迟到许可失效', async () => {
  const f = fixture()
  let ready: () => void = () => {}
  const asked = new Promise<void>((resolve) => {
    ready = resolve
  })
  let release: () => void = () => {}
  let dismissed = 0
  let held = 0
  f.context.hold = () => {
    held++
    return () => {
      held--
    }
  }
  f.context.approvals.request = async (request, signal) => {
    ready()
    await new Promise<void>((resolve) => {
      release = resolve
      signal.addEventListener('abort', resolve.bind(null), { once: true })
    })
    return { requestId: request.id, nonce: request.nonce, scope: request.scope, decision: 'always' }
  }
  f.context.approvals.dismiss = async () => {
    dismissed++
  }
  const pending = f.runtime.executor.execute(call(), f.context)
  await asked
  await f.runtime.executor.endTurn(scope)
  release()
  assert.equal((await pending).success, false)
  assert.equal(held, 0)
  assert.equal(dismissed, 1)
  assert.equal(f.requests.filter((item) => item.method === 'turnEnded').length, 1)
  assert.equal((await f.runtime.executor.execute(call(), f.context)).success, false)
  await f.runtime.dispose()
  await f.runtime.dispose()
  assert.equal(f.disposed(), 1)
})

test('会话授权在 endSession 释放，宿主键中的斜线不碰撞', async () => {
  const f = fixture()
  let requests = 0
  f.context.approvals.request = async (request) => {
    requests++
    return {
      requestId: request.id,
      nonce: request.nonce,
      scope: request.scope,
      decision: 'session',
    }
  }
  await f.runtime.executor.execute(call(), f.context)
  await f.runtime.executor.endTurn(scope)
  await f.runtime.executor.execute({ ...call(), scope: { ...scope, turnId: 't2' } }, f.context)
  assert.equal(requests, 1)
  await f.runtime.executor.endSession(scope)
  await f.runtime.executor.execute({ ...call(), scope: { ...scope, turnId: 't3' } }, f.context)
  assert.equal(requests, 2)
  const a = { ...scope, deviceId: 'a/b', sessionId: 'c', turnId: 'u' }
  const b = { ...scope, deviceId: 'a', sessionId: 'b/c', turnId: 'u' }
  await f.runtime.executor.execute({ ...call(), scope: a }, f.context)
  await f.runtime.executor.execute({ ...call(), scope: b }, f.context)
  const sessions = f.requests
    .filter((item) => item.method === 'click')
    .map((item) => item.params.session)
  assert.notEqual(sessions.at(-1), sessions.at(-2))
  await f.runtime.dispose()
})

test('截图按公共 ToolResult 返回，目标内容中的产品名不被替换', async () => {
  const f = fixture()
  const result = await f.runtime.executor.execute(call('get_app_state'), f.context)
  assert.equal(result.success, true)
  assert.ok(JSON.stringify(result).includes('Litch user content'))
  assert.ok(JSON.stringify(result).includes('Test Host workflow'))
  assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: 'YWJj' })
  await f.runtime.dispose()
})

test('未知工具和无效批次拒绝，不发输入；批次首步失败不重放', async () => {
  const f = fixture()
  assert.equal((await f.runtime.executor.execute(call('unknown'), f.context)).success, false)
  assert.equal(
    (
      await f.runtime.executor.execute(
        { ...call('run_actions'), arguments: { actions: [] } },
        f.context,
      )
    ).success,
    false,
  )
  assert.equal(f.requests.length, 0)
  await f.runtime.dispose()
})
