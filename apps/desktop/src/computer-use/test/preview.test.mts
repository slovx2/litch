import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAutomationPreviewHost } from '../../automation-preview/host.mjs'
import type { ClientToolInvocation } from '../../client-tools/types.mjs'
import type { HelperAccess } from '../executor-shared.mjs'

test('预览按调用来源登记，旧代帧和确认不进入新窗口', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const emitted: unknown[] = []
  const helper = {
    connected: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return {}
      },
    },
  } as HelperAccess
  const host = createAutomationPreviewHost(helper, (view, owner) => emitted.push({ view, owner }))
  const owner = { deviceId: 'remote', sessionId: 's' }
  const session = 'remote/s'
  const surface = {
    surfaceId: 'w',
    executorId: 'h',
    generation: 1,
    geometryRevision: 1,
    kind: 'nativeWindow',
    width: 100,
    height: 60,
  }
  const notice = { event: 'surface', session, surface, app: 'Fixture' }
  host.receive(notice)
  assert.equal(emitted.length, 0)
  host.register({ device: { id: 'remote' }, threadId: 's' } as ClientToolInvocation, session)
  host.receive(notice)
  assert.equal(emitted.length, 1)
  host.receive({
    event: 'frame',
    session,
    surface: { ...surface, generation: 0 },
    streamId: 'old',
    seq: 1,
    data: 'a',
    pixelWidth: 100,
    pixelHeight: 60,
  })
  assert.equal(emitted.length, 1)
  host.receive({
    event: 'frame',
    session,
    surface,
    streamId: 'new',
    seq: 1,
    data: 'a',
    pixelWidth: 100,
    pixelHeight: 60,
  })
  await host.control({ ...owner, action: 'ack', streamId: 'old', seq: 1 })
  assert.equal(calls.length, 0)
  await host.control({ ...owner, action: 'ack', streamId: 'new', seq: 1 })
  assert.equal(calls[0]?.method, 'previewAck')
  host.receive({ event: 'status', session, status: 'restoreFailed' })
  for (const status of ['failed', 'completed']) {
    host.receive({ event: 'status', session, status })
    assert.equal((emitted.at(-1) as { view: { status: string } }).view.status, 'restoreFailed')
  }
  host.receive({ event: 'removed', session })
  await host.control({ ...owner, action: 'takeover' })
  assert.equal(calls.length, 1)
})

test('空面板不拉起助手，隐藏与停止分开', async () => {
  const host = createAutomationPreviewHost({ connected: null } as HelperAccess, () => {})
  await host.control({ deviceId: 'local', sessionId: 'unused', action: 'show' })
  await host.control({ deviceId: 'local', sessionId: 'unused', action: 'hide' })
  host.disconnected()
})

test('面板意图跨回合、采集拒绝和助手重连恢复，核心退出才清除', async () => {
  const calls: string[] = []
  const emitted: Array<unknown> = []
  const helper = {
    connected: {
      request: async (method: string) => {
        calls.push(method)
        return {}
      },
    },
  } as HelperAccess
  const host = createAutomationPreviewHost(helper, (view) => emitted.push(view))
  const owner = { deviceId: 'local', sessionId: 's' }
  const session = 'helper-session'
  const invocation = { device: { id: 'local' }, threadId: 's' } as ClientToolInvocation
  const surface = {
    surfaceId: 'w',
    executorId: 'h',
    generation: 1,
    geometryRevision: 1,
    kind: 'nativeWindow',
    width: 100,
    height: 60,
  }
  const notice = { event: 'surface', session, surface, app: 'Fixture', status: 'ready' }
  await host.control({ ...owner, action: 'show' })
  host.register(invocation, session)
  host.receive(notice)
  assert.deepEqual(calls, ['previewSubscribe'])
  host.receive(notice)
  assert.equal(calls.length, 1, '同版 surface 不重复开流')
  host.receive({ event: 'removed', session })
  host.register(invocation, session)
  host.receive({ ...notice, surface: { ...surface, generation: 2 } })
  assert.equal(calls.length, 2, '下回合恢复')
  host.receive({ event: 'status', session, status: 'captureDenied' })
  host.receive({ event: 'removed', session })
  assert.equal((emitted.at(-1) as { status: string }).status, 'captureDenied')
  assert.equal((emitted.at(-1) as { surface: unknown }).surface, null)
  host.disconnected()
  assert.equal(emitted.at(-1), null, '保留的错误卡也随助手断线清除')
  host.register(invocation, session)
  host.receive(notice)
  assert.equal(calls.length, 3, '重连恢复')
  host.disconnected(true)
  host.register(invocation, session)
  host.receive(notice)
  assert.equal(calls.length, 3, '核心退出丢弃旧面板意图')
  await host.control({ ...owner, action: 'show' })
  await host.control({ ...owner, action: 'hide' })
  const count = calls.length
  host.receive({ event: 'removed', session })
  host.register(invocation, session)
  host.receive(notice)
  assert.equal(calls.length, count, '用户隐藏后不自动重开')
})
