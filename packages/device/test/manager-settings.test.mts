import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type ManagerCreateParams,
} from '../../protocol/src/manager.mjs'
import { prepareInstructions } from '../src/codex-instructions.mjs'
import { managerInstructions, managerTools, refreshManagerRules } from '../src/manager-rules.mjs'
import { validateCreate, validatePatch } from '../src/manager-validate.mjs'
import { treeRig } from './tree-kit.mjs'

const settings = (cwd: string): ManagerCreateParams => ({
  cwd,
  harness: 'pi',
  model: null,
  effort: null,
  name: '经理设定验收',
  scope: '',
  rules: '',
  template: 'blank',
  firstTask: '',
  dispatch: { ...MANAGER_DEFAULT_DISPATCH },
  contact: { ...MANAGER_DEFAULT_CONTACT },
})

test('经理设定：创建和修改允许空范围及空设定，保留用户原文，仍校验字段类型', async () => {
  const env = treeRig()
  try {
    const input = settings(env.stateDir)
    assert.equal(validateCreate(input).scope, '')
    assert.deepEqual(validatePatch({ scope: '', rules: '' }), { scope: '', rules: '' })
    assert.throws(() => validateCreate({ ...input, scope: null }), /scope must be text/)
    assert.throws(() => validatePatch({ scope: 1 }), /scope must be text/)
    assert.throws(() => validatePatch({ rules: null }), /rules must be text/)
    assert.equal(input.dispatch.worktree, false)
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager } = await client.call(MANAGER_METHOD.create, input)
    assert.equal(manager.scope, '')
    assert.equal(manager.rules, '')
    const rules = '  中文角色设定\n\n保留行距与空格。  '
    const updated = await client.call(MANAGER_METHOD.update, {
      managerId: manager.id,
      scope: '',
      rules,
    })
    assert.equal(updated.manager.rules, rules)
    const cleared = await client.call(MANAGER_METHOD.update, {
      managerId: manager.id,
      scope: '',
      rules: '',
    })
    assert.equal(cleared.manager.rules, '')
    assert.doesNotMatch(managerInstructions(cleared.manager), /Your scope:/)
  } finally {
    await env.close()
  }
})

test('经理自动规则：更新任务分配后恢复和分叉均采用最新设置，用户设定保持最后且不承诺桌面通知', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const input = { ...settings(env.stateDir), rules: 'CUSTOM-PROMPT-END' }
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, input)
    const original = managerInstructions(manager)
    assert.match(original, /share the working folder/)
    assert.match(original, /At most 4 work lines/)
    assert.match(original, /manager merges the work line/)
    assert.doesNotMatch(original.split('\n<!--')[0] ?? '', /desktop notification/i)
    const context = {
      store: env.device.sessionTree.store,
      ask: async () => ({ config: { developer_instructions: 'project rules' } }),
      log: () => {},
    }
    const start = await prepareInstructions(
      'thread/start',
      {
        cwd: env.stateDir,
        dynamicTools: managerTools(manager),
      },
      context,
    )
    assert.ok(start)
    start.remember({ thread: { id: threadId, cwd: env.stateDir } })
    const dispatch = {
      harness: 'claude-code',
      model: 'test-model',
      effort: 'high',
      worktree: true,
      merge: 'user' as const,
      maxRunningLines: 2,
    }
    const { manager: updated } = await client.call(MANAGER_METHOD.update, {
      managerId: manager.id,
      dispatch,
      contact: { desktopNotification: false, unanswered: 'wait' },
    })
    const current = managerInstructions(updated)
    const body = current.split('\n<!--')[0] ?? ''
    assert.ok(body.endsWith(input.rules))
    assert.match(body, /Default work line harness: claude-code/)
    assert.match(body, /Default work line model: test-model/)
    assert.match(body, /reasoning effort: high/)
    assert.match(body, /Use separate worktrees/)
    assert.match(body, /At most 2 work lines/)
    assert.match(body, /The user merges work lines/)
    assert.match(body, /Wait for unanswered decisions/)
    assert.doesNotMatch(body, /share the working folder|At most 4 work lines|desktop notification/i)
    assert.equal(refreshManagerRules('litch_manager', current), current)
    for (const method of ['thread/resume', 'thread/fork']) {
      const prepared = await prepareInstructions(method, { threadId }, context)
      assert.ok(prepared)
      const text = String(prepared.params.developerInstructions)
      assert.match(text, /project rules/)
      assert.match(text, /At most 2 work lines/)
      assert.match(text, /Keep at most 2 lines/)
      assert.match(text, /The user merges work lines/)
      assert.match(text, /CUSTOM-PROMPT-END/)
      assert.doesNotMatch(text, /At most 4 work lines|Keep at most 4 lines/)
    }
  } finally {
    await env.close()
  }
})
