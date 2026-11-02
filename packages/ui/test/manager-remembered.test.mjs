import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  fitManagerHarness,
  fitManagerModels,
  managerDevice,
  managerWorkspace,
  recallManager,
  rememberManager,
} from '../src/manager/remembered.ts'

const stored = new Map()
beforeEach(() => {
  stored.clear()
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  }
})
const local = {
  id: 'local',
  kind: 'local',
  connection: 'online',
  harnesses: [{ id: 'a', state: 'ready' }],
}
const remote = { ...local, id: 'remote', kind: 'ssh' }
const base = () => ({
  name: '',
  firstTask: '',
  cwd: '',
  harness: '',
  model: null,
  effort: null,
  rules: '',
  dispatch: {
    harness: null,
    model: null,
    effort: null,
    worktree: false,
    merge: 'manager',
    maxRunningLines: 4,
  },
  contact: { desktopNotification: true, unanswered: 'wait' },
})
const saved = () => ({
  ...base(),
  name: '一次性名称',
  firstTask: '一次性任务',
  cwd: '/repo',
  harness: 'a',
  model: 'm',
  effort: 'high',
  rules: '复用的规则',
  dispatch: {
    harness: 'a',
    model: 'm',
    effort: 'low',
    worktree: true,
    merge: 'user',
    maxRunningLines: 2,
  },
  contact: { desktopNotification: false, unanswered: 'wait' },
})
const options = {
  models: [{ id: 'm', isDefault: true, efforts: [{ id: 'low' }, { id: 'high' }] }],
  permissions: [],
  plan: false,
}

test('成功创建记住全部可复用参数，名称和任务从不落盘，不影响普通新建对话', () => {
  stored.set('litch.lastDevice', '{"id":"ordinary"}')
  rememberManager('remote', 'project', saved())
  assert.equal(managerDevice([local, remote]), 'remote')
  assert.equal(managerWorkspace('remote'), 'project')
  assert.deepEqual(recallManager(remote, base()), { ...saved(), name: '', firstTask: '' })
  assert.equal(stored.get('litch.lastDevice'), '{"id":"ordinary"}')
  assert.doesNotMatch([...stored.values()].join(''), /一次性/)
  const draft = recallManager(remote, base())
  draft.dispatch.worktree = false
  draft.rules = '没有保存的修改'
  assert.equal(recallManager(remote, base()).dispatch.worktree, true)
  assert.equal(recallManager(remote, base()).rules, '复用的规则')
})

test('按设备隔离，明确指定优先；已删除设备退回本机，不带入另一台的目录或模型', () => {
  rememberManager('remote', 'project', saved())
  assert.equal(managerDevice([local, remote], 'local'), 'local')
  assert.equal(managerDevice([local]), 'local')
  assert.equal(managerDevice([]), '')
  assert.equal(recallManager(local, base()).cwd, '')
  assert.equal(managerWorkspace('local'), '')
  rememberManager('local', '', { ...saved(), cwd: '/local' })
  assert.equal(managerDevice([remote, local]), 'local')
  assert.equal(recallManager(remote, base()).cwd, '/repo')
})

test('失效 harness 同时清掉自己的模型强度，派线有效的独立 harness 不受影响', () => {
  const device = { ...local, harnesses: [{ id: 'b', state: 'ready' }] }
  rememberManager('local', '', saved())
  const restored = recallManager(device, base())
  assert.equal(restored.harness, 'b')
  assert.equal(restored.model, null)
  assert.equal(restored.effort, null)
  assert.deepEqual(restored.dispatch, {
    ...saved().dispatch,
    harness: null,
    model: null,
    effort: null,
  })
  const distinct = fitManagerHarness(
    { ...saved(), dispatch: { ...saved().dispatch, harness: 'b' } },
    device,
  )
  assert.equal(distinct.dispatch.model, 'm')
  const inherited = fitManagerHarness(
    { ...saved(), dispatch: { ...saved().dispatch, harness: null } },
    device,
  )
  assert.equal(inherited.dispatch.model, null)
  assert.equal(fitManagerHarness(saved(), { ...local, harnesses: [] }).harness, '')
})

test('异步清单回来前不丢记忆，失效模型连同强度回退，失效强度单独回退', () => {
  assert.deepEqual(fitManagerModels(saved(), null, null), saved())
  assert.deepEqual(fitManagerModels(saved(), options, options), saved())
  const stale = fitManagerModels(saved(), { ...options, models: [] }, { ...options, models: [] })
  assert.equal(stale.model, null)
  assert.equal(stale.effort, null)
  assert.equal(stale.dispatch.model, null)
  assert.equal(stale.dispatch.effort, null)
  const noEffort = fitManagerModels(
    saved(),
    { ...options, models: [{ id: 'm', efforts: [] }] },
    options,
  )
  assert.equal(noEffort.model, 'm')
  assert.equal(noEffort.effort, null)
  assert.equal(noEffort.dispatch.effort, 'low')
})

test('派线跟随经理模型时按继承后的模型校验强度；默认模型同样校验', () => {
  const catalog = {
    ...options,
    models: [...options.models, { id: 'other', efforts: [{ id: 'max' }] }],
  }
  const draft = {
    ...saved(),
    model: 'other',
    effort: 'max',
    dispatch: { ...saved().dispatch, model: null, effort: 'max' },
  }
  assert.equal(fitManagerModels(draft, catalog, catalog).dispatch.effort, 'max')
  assert.equal(fitManagerModels({ ...draft, model: null }, catalog, catalog).dispatch.effort, null)
})

test('损坏或不可用的本机存储不报错，非法并发和枚举采用默认', () => {
  for (const bad of ['{', 'null', '[]', '42']) {
    stored.set('litch.manager.defaults:local', bad)
    assert.deepEqual(recallManager(local, base()), { ...base(), harness: 'a' })
  }
  stored.set(
    'litch.manager.defaults:local',
    JSON.stringify({
      dispatch: { maxRunningLines: -1, merge: 'unknown', worktree: 'yes' },
      contact: null,
    }),
  )
  assert.deepEqual(recallManager(local, base()).dispatch, base().dispatch)
  globalThis.localStorage = {
    getItem() {
      throw new Error('不可读')
    },
    setItem() {
      throw new Error('不可写')
    },
  }
  assert.doesNotThrow(() => rememberManager('local', '', saved()))
  assert.equal(recallManager(local, base()).harness, 'a')
})

test('新建入口没有明确项目时恢复保存项目，空串和 null 不覆盖；明确项目只作用于同一设备', () => {
  rememberManager('remote', 'infra', { ...saved(), cwd: '/srv/work/infra' })
  for (const workspaceId of [undefined, null, ''])
    assert.equal(managerWorkspace('remote', { deviceId: 'remote', workspaceId }), 'infra')
  assert.equal(managerWorkspace('remote'), 'infra')
  assert.equal(
    managerWorkspace('remote', { deviceId: 'remote', workspaceId: 'explicit' }),
    'explicit',
  )
  assert.equal(managerWorkspace('remote', { deviceId: 'local', workspaceId: 'explicit' }), 'infra')
  assert.equal(recallManager(remote, base()).cwd, '/srv/work/infra')
})
