import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagerCreateParams } from '../../protocol/src/manager.mjs'
import type { ChannelError } from '../src/channel/protocol.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { createManagers } from '../src/device/manager.mjs'
import { managerValidationError } from '../src/device/manager-validation.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { systemClock } from './helpers.mjs'

const draft: ManagerCreateParams = {
  cwd: '/project',
  harness: 'codex',
  model: 'gpt-6-astra',
  effort: 'high',
  name: '',
  scope: '',
  rules: '',
  firstTask: '',
  template: 'blank',
  dispatch: {
    harness: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    worktree: false,
    merge: 'manager',
    maxRunningLines: 4,
  },
  contact: { desktopNotification: true, unanswered: 'wait' },
}

test('创建经理：合法配置发往设备，参数错误在客户端定位；旧设备信息不足不会伪装成已知原因', async () => {
  const manager = sampleManagers('local', 1_800_000_000, 'zh-CN').managers[0]
  assert.ok(manager)
  let calls = 0
  let failure: RpcError | null = null
  const service = createManagers({
    clock: systemClock,
    deviceId: 'fixture',
    online: () => true,
    supported: () => true,
    features: () => ({ feedback: true, posts: true, ignore: true }),
    changed() {},
    log() {},
    fail: (error) => error as ChannelError,
    request: async (_method, input): Promise<any> => {
      calls++
      if (failure) throw failure
      assert.deepEqual(input, draft)
      return { manager, threadId: manager.threadId }
    },
  })
  await service.create(draft)
  assert.equal(calls, 1)
  for (const [patch, key] of [
    [{ cwd: 'relative' }, 'cwd'],
    [{ rules: null }, 'rules'],
    [{ dispatch: { ...draft.dispatch, maxRunningLines: 0 } }, 'dispatch.maxRunningLines'],
  ] as const)
    await assert.rejects(service.create({ ...draft, ...patch } as ManagerCreateParams), {
      code: 'invalid',
      key,
    })
  assert.equal(calls, 1)
  failure = new RpcError(-32602, 'cwd must exist.', {
    litch: 'invalidManager',
    field: 'cwd',
    reason: 'missingDirectory',
  })
  await assert.rejects(service.create(draft), (error: ChannelError) => {
    assert.equal(error.key, 'cwd')
    assert.match(error.said?.['zh-CN'] ?? '', /工作目录.*不存在.*选择/)
    return true
  })
  failure = new RpcError(-32602, 'cwd must exist.', { litch: 'invalidManager', field: 'cwd' })
  await assert.rejects(service.create(draft), (error: ChannelError) => {
    assert.equal(error.key, 'cwd')
    assert.match(error.said?.['zh-CN'] ?? '', /未返回具体校验原因.*升级设备服务/)
    assert.doesNotMatch(error.said?.['zh-CN'] ?? '', /设备服务版本较旧/)
    return true
  })
  for (const error of [
    new RpcError(-32601, 'Unknown manager method'),
    new RpcError(-32602, 'Unknown manager method: litch/manager/create.', {
      litch: 'invalidManager',
    }),
  ]) {
    failure = error
    await assert.rejects(service.create(draft), (caught: ChannelError) => {
      assert.equal(caught.code, 'unsupported')
      assert.match(caught.said?.['zh-CN'] ?? '', /设备服务版本较旧/)
      return true
    })
  }
})

test('字段错误提供中英文修正提示并保留设备原始错误', () => {
  for (const [field, reason, text] of [
    ['dispatch.harness', 'unavailableHarness', '子会话'],
    ['dispatch.maxRunningLines', 'positiveInteger', '大于 0'],
    ['permission', 'unsupportedPermission', '访问权限'],
    ['cwd', 'notDirectory', '指向文件'],
    ['cwd', 'unreadableDirectory', '无法访问'],
    ['contact.desktopNotification', 'boolean', '请选择'],
  ]) {
    const error = managerValidationError('raw device error', field, reason)
    assert.equal(error.message, 'raw device error')
    assert.equal(error.key, field)
    assert.ok(error.said?.['zh-CN'].includes(text ?? ''))
    assert.ok(error.said?.en)
  }
})
