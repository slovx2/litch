import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PROJECT_PERMISSION } from '../../protocol/src/harness-project-permissions.mjs'
import { MANAGER_DEFAULT_CONTACT, MANAGER_DEFAULT_DISPATCH } from '../../protocol/src/manager.mjs'
import type { EngineLink } from '../src/engine-link.mjs'
import { ProjectPermissions } from '../src/project-permissions.mjs'
import { childPermissions } from '../src/session-permissions.mjs'
import { resultOf } from './fake-engine.mjs'
import { brief, litch, parent, SESSIONS, treeRig, until } from './tree-kit.mjs'

const levels = [':read-only', ':workspace', ':danger-full-access']
const link = (permissions = levels) =>
  ({
    native: false,
    runtime: { permissionPresets: permissions.map((id) => ({ id })) },
  }) satisfies Pick<EngineLink, 'native' | 'runtime'>

test('三档只允许同档继承或降低；未知、冲突、未声明的权限拒绝', () => {
  for (const [rank, permission] of levels.entries()) {
    const config = { activePermissionProfile: { id: permission }, approvalPolicy: 'on-request' }
    assert.equal(childPermissions(config, {}, link()).permissions, permission)
    for (const [other, requested] of levels.entries()) {
      if (other <= rank)
        assert.equal(
          childPermissions(config, { permission: requested }, link()).permissions,
          requested,
        )
      else
        assert.throws(() => childPermissions(config, { permission: requested }, link()), {
          message: /exceeds/,
        })
    }
  }
  assert.throws(() => childPermissions(null, {}, link()), /Cannot compare/)
  assert.throws(
    () =>
      childPermissions(
        { activePermissionProfile: 'custom', sandbox: { type: 'workspaceWrite' } },
        {},
        link(),
      ),
    /Cannot compare/,
  )
  assert.throws(
    () => childPermissions({ sandbox: { type: 'readOnly' } }, {}, link([':danger-full-access'])),
    { message: /does not support/ },
  )
  assert.throws(() => childPermissions({ sandbox: { type: 'readOnly' } }, {}, link([])), {
    message: /does not support/,
  })
  assert.throws(
    () =>
      childPermissions(
        { sandbox: { type: 'workspaceWrite' } },
        { permission: ':read-only', sandbox: 'workspace-write' },
        link(),
      ),
    /conflict/,
  )
  assert.throws(
    () =>
      childPermissions(
        { sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' },
        { approvalPolicy: 'never' },
        link(),
      ),
    /approval policy/,
  )
})

test('设备统一校验工具、客户端派出与提案；提案未指定时按开始时父权限', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const tool = async (name: string, args: object) =>
      resultOf((await env.pi.callTool(threadId, SESSIONS, name, args))?.answer)
    const result = await tool('start', {
      title: '只读线',
      ...brief('只读线'),
      permission: ':read-only',
      initiation: 'user_asked',
    })
    assert.ok(result.thread_id)
    assert.equal(env.pi.sent('thread/start').at(-1)?.permissions, ':read-only')
    const before = env.pi.sent('thread/start').length
    await assert.rejects(
      client.call('litch/session/start', {
        parentThreadId: threadId,
        title: '越权',
        prompt: '任务',
        kind: 'fresh',
        wakeParent: true,
        permission: ':danger-full-access',
      }),
      { message: /exceeds/ },
    )
    assert.equal(env.pi.sent('thread/start').length, before)
    const lower = await tool('start', {
      title: '提案记住低档',
      ...brief('提案记住低档'),
      permission: ':read-only',
    })
    assert.equal(env.device.sessionTree.store.proposal(lower.proposal_id)?.permission, ':read-only')
    await client.call('litch/sessionProposal/accept', { proposalId: lower.proposal_id })
    assert.equal(env.pi.sent('thread/start').at(-1)?.permissions, ':read-only')
    const handed = await tool('hand_off', { title: '交接继承', remaining_plan: '继续剩余任务' })
    assert.ok(handed.thread_id)
    assert.equal(env.pi.sent('thread/fork').at(-1)?.permissions, ':workspace')
    const proposed = await tool('start', { title: '继承最新', ...brief('继承最新') })
    env.pi.config = { approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } }
    await client.call('litch/sessionProposal/accept', { proposalId: proposed.proposal_id })
    assert.equal(env.pi.sent('thread/start').at(-1)?.permissions, ':read-only')
    env.claude.declaration = { permissionPresets: [{ id: ':danger-full-access' }] }
    await assert.rejects(
      client.call('litch/session/start', {
        parentThreadId: threadId,
        harness: 'claude-code',
        title: '无低档',
        prompt: '任务',
        kind: 'fresh',
        wakeParent: true,
      }),
      { message: /does not support/ },
    )
    assert.equal(env.claude.sent('thread/start').length, 0)
  } finally {
    await env.close()
  }
})

test('同 harness 的项目确认按设备真实目录共享，降低默认保留确认；经理继承且可覆盖', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'harnessProjectPermissions', 'litchManager'])
    const plain = env.connect()
    await plain.initialize(['harness'])
    const another = env.connect()
    await another.initialize(['harness', 'harnessProjectPermissions'])
    const cwd = join(env.stateDir, 'project')
    mkdirSync(cwd)
    const alias = join(env.stateDir, 'alias')
    symlinkSync(cwd, alias)
    await assert.rejects(plain.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd }), {
      message: /harnessProjectPermissions/,
    })
    await assert.rejects(
      client.call(PROJECT_PERMISSION.set, {
        harness: 'pi',
        cwd,
        permission: ':danger-full-access',
        confirmed: false,
      }),
      { message: /确认/ },
    )
    await client.call(PROJECT_PERMISSION.set, {
      harness: 'pi',
      cwd,
      permission: ':danger-full-access',
      confirmed: true,
    })
    const read = await client.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: alias })
    assert.equal(read.cwd, realpathSync(cwd))
    assert.deepEqual(read.confirmedPermissions, [':danger-full-access'])
    assert.deepEqual(
      await another.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: alias }),
      read,
    )
    await until(
      () => another.notifications.some((entry) => entry.method === PROJECT_PERMISSION.changed),
      '另一声明连接收到项目权限变化',
    )
    await client.call(PROJECT_PERMISSION.set, {
      harness: 'pi',
      cwd,
      permission: ':read-only',
      confirmed: false,
    })
    await client.call(PROJECT_PERMISSION.set, {
      harness: 'pi',
      cwd: alias,
      permission: ':danger-full-access',
      confirmed: false,
    })
    // 新连接到持久化库仍读到确认，不依赖客户端或原存储实例的内存。
    const reopened = new DatabaseSync(join(env.stateDir, 'device.sqlite'))
    try {
      const stored = new ProjectPermissions(reopened, () => {}).read(alias, 'pi')
      assert.deepEqual(stored.confirmedPermissions, [':danger-full-access'])
      assert.equal(stored.permission, ':danger-full-access')
    } finally {
      reopened.close()
    }
    const isolated = new DatabaseSync(':memory:')
    try {
      assert.equal(new ProjectPermissions(isolated, () => {}).read(cwd, 'pi').permission, null)
    } finally {
      isolated.close()
    }
    assert.equal(
      (await client.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: env.stateDir })).permission,
      null,
    )
    assert.equal(
      plain.notifications.some((entry) => entry.method === PROJECT_PERMISSION.changed),
      false,
    )
    const input = {
      cwd,
      harness: 'pi',
      model: null,
      effort: null,
      name: '权限经理',
      scope: '',
      template: 'blank',
      rules: '',
      firstTask: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH },
      contact: { ...MANAGER_DEFAULT_CONTACT },
    }
    const created = await client.call('litch/manager/create', input)
    assert.equal(created.manager.permission, ':danger-full-access')
    assert.equal(env.pi.sent('thread/start').at(-1)?.permissions, ':danger-full-access')
    const changed = await client.call('litch/manager/create', {
      ...input,
      harness: 'claude-code',
      permission: ':read-only',
    })
    assert.equal(changed.manager.permission, ':read-only')
    assert.equal(env.claude.sent('thread/start').at(-1)?.permissions, ':read-only')
    assert.equal(
      (await client.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd })).permission,
      ':danger-full-access',
      '经理覆盖不会伪造用户项目确认',
    )
  } finally {
    await env.close()
  }
})

test('无项目的权限按设备和 harness 持久化；与真实目录和别名互不覆盖', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'harnessProjectPermissions'])
    await client.call(PROJECT_PERMISSION.set, {
      harness: 'pi',
      cwd: '',
      permission: ':danger-full-access',
      confirmed: true,
    })
    const second = env.connect()
    await second.initialize(['harness', 'harnessProjectPermissions'])
    const loose = await second.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: '' })
    assert.equal(loose.permission, ':danger-full-access')
    assert.deepEqual(loose.confirmedPermissions, [':danger-full-access'])
    await client.call(PROJECT_PERMISSION.set, {
      harness: 'pi',
      cwd: env.stateDir,
      permission: ':read-only',
      confirmed: false,
    })
    assert.equal(
      (await second.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: '' })).permission,
      ':danger-full-access',
    )
    await assert.rejects(client.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: 'relative' }), {
      message: /absolutePath/,
    })
    await assert.rejects(client.call(PROJECT_PERMISSION.read, { harness: 'pi' }), {
      message: /cwd/,
    })
    const reopened = new DatabaseSync(join(env.stateDir, 'device.sqlite'))
    try {
      assert.deepEqual(new ProjectPermissions(reopened, () => {}).read('', 'pi'), loose)
    } finally {
      reopened.close()
    }
  } finally {
    await env.close()
  }
})

test('同目录两个 harness 各记各的；确认按引擎声明且不跨 harness 继承，无项目也隔离', async () => {
  const env = treeRig()
  env.pi.declaration = {
    permissionPresets: [{ id: ':danger-full-access', requiresConfirmation: false }],
  }
  env.claude.declaration = {
    permissionPresets: [
      { id: ':danger-full-access', requiresConfirmation: true },
      { id: ':read-only', requiresConfirmation: false },
    ],
  }
  try {
    const client = env.connect()
    await client.initialize(['harness', 'harnessProjectPermissions'])
    const second = env.connect()
    await second.initialize(['harness', 'harnessProjectPermissions'])
    for (const cwd of [env.stateDir, '']) {
      await client.call(PROJECT_PERMISSION.set, {
        cwd,
        harness: 'pi',
        permission: ':danger-full-access',
        confirmed: false,
      })
      const pi = await second.call(PROJECT_PERMISSION.read, { cwd, harness: 'pi' })
      assert.equal(pi.permission, ':danger-full-access')
      assert.deepEqual(pi.confirmedPermissions, [], '免确认不是伪造已确认')
      assert.equal(
        (await second.call(PROJECT_PERMISSION.read, { cwd, harness: 'claude-code' })).permission,
        null,
      )
      await assert.rejects(
        client.call(PROJECT_PERMISSION.set, {
          cwd,
          harness: 'claude-code',
          permission: ':danger-full-access',
          confirmed: false,
        }),
        { message: /确认/ },
      )
      await client.call(PROJECT_PERMISSION.set, {
        cwd,
        harness: 'claude-code',
        permission: ':danger-full-access',
        confirmed: true,
      })
      await client.call(PROJECT_PERMISSION.set, {
        cwd,
        harness: 'claude-code',
        permission: ':read-only',
        confirmed: false,
      })
      assert.equal(
        (await second.call(PROJECT_PERMISSION.read, { cwd, harness: 'claude-code' })).permission,
        ':read-only',
      )
      assert.deepEqual(await second.call(PROJECT_PERMISSION.read, { cwd, harness: 'pi' }), pi)
      await client.call(PROJECT_PERMISSION.set, {
        cwd,
        harness: 'claude-code',
        permission: ':danger-full-access',
        confirmed: false,
      })
    }
    const old = env.connect()
    await old.initialize(['harness', 'projectPermissions'])
    await assert.rejects(old.call(PROJECT_PERMISSION.read, { cwd: env.stateDir, harness: 'pi' }), {
      message: /harnessProjectPermissions/,
    })
  } finally {
    await env.close()
  }
})
