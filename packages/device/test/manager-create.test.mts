import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ManagerCreateParams } from '../../protocol/src/manager.mjs'
import { managerInputIssue } from '../../protocol/src/manager-validation.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'

const settings = (cwd: string): ManagerCreateParams => ({
  cwd,
  harness: 'codex',
  model: 'gpt-6-astra',
  effort: 'high',
  name: '',
  scope: '',
  rules: '',
  firstTask: '',
  template: 'blank',
  permission: null,
  dispatch: {
    harness: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    worktree: false,
    merge: 'manager',
    maxRunningLines: 4,
  },
  contact: { desktopNotification: true, unanswered: 'wait' },
})

const codexEngine = () => {
  const engine = new FakeEngine('codex')
  engine.handlers['model/list'] = () => ({
    data: [
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      },
    ],
    nextCursor: null,
  })
  return engine
}

test('截图配置能创建并落库；目录、harness 与权限失败返回字段和稳定原因，不创建半成品', async () => {
  const env = rig({ codex: codexEngine() })
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const input = settings(env.stateDir)
    const { manager } = await client.call('litch/manager/create', input)
    assert.deepEqual(env.device.managers.store.manager(manager.id)?.dispatch, input.dispatch)
    writeFileSync(join(env.stateDir, 'file'), '')
    const cases: [Partial<ManagerCreateParams>, string, string][] = [
      [{ cwd: 'relative' }, 'cwd', 'absolutePath'],
      [{ cwd: join(env.stateDir, 'missing') }, 'cwd', 'missingDirectory'],
      [{ cwd: join(env.stateDir, 'file') }, 'cwd', 'notDirectory'],
      [{ harness: 'removed' }, 'harness', 'unavailableHarness'],
      [
        { dispatch: { ...input.dispatch, harness: 'removed' } },
        'dispatch.harness',
        'unavailableHarness',
      ],
      [{ model: 'removed' }, 'model', 'unavailableModel'],
      [{ effort: 'removed' }, 'effort', 'unsupportedEffort'],
      [{ dispatch: { ...input.dispatch, model: 'removed' } }, 'dispatch.model', 'unavailableModel'],
      [
        { dispatch: { ...input.dispatch, effort: 'removed' } },
        'dispatch.effort',
        'unsupportedEffort',
      ],
      [{ permission: 'removed' }, 'permission', 'unsupportedPermission'],
    ]
    for (const [patch, field, reason] of cases) {
      const error = await client.fails('litch/manager/create', { ...input, ...patch })
      assert.equal(error.code, -32602)
      assert.equal(error.data.litch, 'invalidManager')
      assert.equal(error.data.field, field)
      assert.equal(error.data.reason, reason)
      if (field === 'cwd') assert.equal(error.data.value, patch.cwd)
    }
    assert.equal((await client.call('litch/manager/list', {})).managers.length, 1)
  } finally {
    await env.close()
  }
})

test('所有参数类型共享同一规则，嵌套错误有完整字段路径', async () => {
  const env = rig({ codex: codexEngine() })
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const valid = settings(env.stateDir)
    const cases: [string, unknown][] = [
      ['name', null],
      ['scope', null],
      ['rules', 1],
      ['firstTask', null],
      ['cwd', ''],
      ['harness', ' '],
      ['model', ''],
      ['effort', 1],
      ['permission', false],
      ['template', 'unknown'],
      ['dispatch', null],
      ['contact', []],
      ['dispatch.harness', ''],
      ['dispatch.model', false],
      ['dispatch.effort', ''],
      ['dispatch.worktree', 'false'],
      ['dispatch.merge', 'auto'],
      ['dispatch.maxRunningLines', 0],
      ['dispatch.maxRunningLines', 1.5],
      ['dispatch.maxRunningLines', Number.MAX_SAFE_INTEGER + 1],
      ['contact.desktopNotification', 1],
      ['contact.unanswered', 'notify'],
      ['dispatch.unknown', true],
      ['contact.unknown', true],
      ['unknown', true],
    ]
    for (const [field, value] of cases) {
      const input = structuredClone(valid) as unknown as Record<string, unknown>
      const [parent, child] = field.split('.') as [string, string | undefined]
      if (child) (input[parent] as Record<string, unknown>)[child] = value
      else input[parent] = value
      const issue = managerInputIssue(input, 'create')
      assert.equal(issue?.field, field)
      const error = await client.fails('litch/manager/create', input)
      assert.equal(error.data.litch, 'invalidManager')
      assert.equal(error.data.field, field)
      assert.equal(error.data.reason, issue?.reason)
    }
    for (const maxRunningLines of [1, 4, Number.MAX_SAFE_INTEGER])
      assert.equal(
        managerInputIssue({ ...valid, dispatch: { ...valid.dispatch, maxRunningLines } }, 'create'),
        null,
      )
    assert.equal(managerInputIssue({ ...valid, rules: '长规则'.repeat(50000) }, 'create'), null)
    assert.equal(managerInputIssue({ scope: '', rules: '' }, 'patch'), null)
    assert.equal((await client.call('litch/manager/list', {})).managers.length, 0)
  } finally {
    await env.close()
  }
})

test('~/ 使用目标设备 home；项目权限预检、会话与落库路径一致，错误保留输入和解析路径', async () => {
  const previous = process.env.HOME
  const deviceHome = mkdtempSync(join(tmpdir(), 'manager-home-'))
  process.env.HOME = deviceHome
  const env = rig({ codex: codexEngine() })
  try {
    assert.equal(homedir(), deviceHome)
    mkdirSync(join(deviceHome, 'project'))
    const client = env.connect()
    await client.initialize(['harness', 'litchManager', 'harnessProjectPermissions'])
    const permission = await client.call('litch/harnessProjectPermission/read', {
      cwd: '~/project',
      harness: 'pi',
    })
    assert.equal(permission.cwd, realpathSync(join(deviceHome, 'project')))
    for (const cwd of ['~', '~/project']) {
      const { manager, threadId } = await client.call('litch/manager/create', settings(cwd))
      const expected = cwd === '~' ? deviceHome : join(deviceHome, 'project')
      assert.equal(manager.cwd, expected)
      assert.equal(env.device.managers.store.manager(manager.id)?.cwd, expected)
      assert.equal((await client.call('thread/read', { threadId })).thread.cwd, expected)
    }
    for (const method of ['litch/manager/create', 'litch/harnessProjectPermission/read']) {
      const error = await client.fails(
        method,
        method.endsWith('/create') ? settings('~/missing') : { cwd: '~/missing', harness: 'codex' },
      )
      assert.equal(error.data.reason, 'missingDirectory')
      assert.equal(error.data.value, '~/missing')
      assert.equal(error.data.resolvedPath, join(deviceHome, 'missing'))
    }
  } finally {
    await env.close()
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    rmSync(deviceHome, { recursive: true, force: true })
  }
})
