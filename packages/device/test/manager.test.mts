import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type ManagerCreateParams,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { prepareInstructions } from '../src/codex-instructions.mjs'
import { managerTools } from '../src/manager-rules.mjs'
import { startChild } from '../src/session-start.mjs'
import type { TestClient } from './helpers.mjs'
import { brief, plain, treeRig, until } from './tree-kit.mjs'

const params = (cwd: string, patch: Partial<ManagerCreateParams> = {}): ManagerCreateParams => ({
  cwd,
  harness: 'pi',
  model: null,
  effort: null,
  name: '测试经理',
  scope: '完成设备实现',
  template: 'blank',
  rules: 'Keep evidence in the repository.',
  dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
  contact: { ...MANAGER_DEFAULT_CONTACT },
  firstTask: '',
  ...patch,
})
async function client(env: ReturnType<typeof treeRig>, extensions = ['harness', 'litchManager']) {
  const connection = env.connect()
  await connection.initialize(extensions)
  return connection
}
async function create(
  env: ReturnType<typeof treeRig>,
  connection: TestClient,
  patch: Partial<ManagerCreateParams> = {},
) {
  const result = await connection.call(MANAGER_METHOD.create, params(env.stateDir, patch))
  await until(() => env.pi.running(result.threadId), '经理开场')
  return result
}
async function tool(
  env: ReturnType<typeof treeRig>,
  threadId: string,
  name: string,
  args: unknown,
  namespace = 'litch_manager',
) {
  const result = await env.pi.callTool(threadId, namespace, name, args)
  assert.ok(result)
  return result.answer.result
}
const value = (response: any) => {
  assert.equal(response.success, true, JSON.stringify(response))
  return JSON.parse(response.contentItems[0].text)
}

test('经理扩展：声明、路由、创建工具/规则、每条投递连接独立 decorate，普通会话伪造工具无权限', async () => {
  const env = treeRig()
  try {
    const declared = await client(env)
    const other = await plain(env)
    const info = await declared.call('runtime/info')
    assert.ok(info.device.extensions.includes('litchManager'))
    for (const method of Object.values(MANAGER_METHOD)) {
      const error = await other.fails(method, {})
      assert.equal(error.data.litch, 'extensionRequired')
      assert.deepEqual(error.data.required, ['litchManager'])
    }
    const { manager, threadId } = await create(env, declared)
    const specs = env.device.sessionTree.store.tools(threadId) as any[]
    assert.ok(
      specs
        .find((spec) => spec.name === 'litch_manager')
        .instructions.includes('You are a Litch manager'),
    )
    const sessions = specs.find((spec) => spec.name === 'litch_sessions')
    assert.ok(sessions.instructions.includes('Manager sessions'))
    assert.equal(
      sessions.tools.some((item: any) => item.name === 'wrap_up'),
      false,
    )
    assert.ok(
      sessions.tools.find((item: any) => item.name === 'start').description.includes('event turns'),
    )
    assert.equal(
      parseSessionEvent(
        String(
          env.pi.current(threadId)?.items[0]?.content &&
            (env.pi.current(threadId)?.items[0]?.content as any)?.[0]?.text,
        ),
      ).event?.kind,
      'manager-open',
    )
    assert.deepEqual((await declared.call('thread/read', { threadId })).thread.litchManager, {
      managerId: manager.id,
      role: 'manager',
    })
    assert.equal((await other.call('thread/read', { threadId })).thread.litchManager, undefined)
    assert.equal(
      (await declared.call('thread/list', {})).data.find((thread: any) => thread.id === threadId)
        .litchManager.role,
      'manager',
    )
    assert.equal(
      (await other.call('thread/list', {})).data.find((thread: any) => thread.id === threadId)
        .litchManager,
      undefined,
    )
    await until(
      () => declared.notifications.some((frame) => frame.method === 'litch/manager/changed'),
      '经理通知到达',
    )
    assert.equal(
      other.notifications.some((frame) => frame.method?.startsWith('litch/manager/')),
      false,
    )
    env.pi.notify('thread/name/updated', { threadId, threadName: '自动命名后的经理' })
    await until(
      () => env.device.managers.manager(manager.id).name === '自动命名后的经理',
      '经理同步自动命名',
    )
    const ordinary = await other.call('thread/start', {
      harness: 'pi',
      cwd: env.stateDir,
      dynamicTools: managerTools(manager),
    })
    const forged = await tool(env, ordinary.thread.id, 'status', { text: '越权' })
    assert.equal(forged.success, false)
    assert.match(forged.contentItems[0].text, /owning manager/)
  } finally {
    await env.close()
  }
})

test('经理：事件回合直接派线、子树标记、默认 harness、并发上限与完整回报', async () => {
  const env = treeRig()
  try {
    const connection = await client(env)
    const { manager, threadId } = await create(env, connection, {
      dispatch: {
        ...MANAGER_DEFAULT_DISPATCH,
        harness: 'claude-code',
        maxRunningLines: 1,
        worktree: false,
      },
    })
    // 调用来自开场事件，设备允许范围内直接派线；开场是否开始由角色规则约束。
    const started = value(
      await tool(
        env,
        threadId,
        'start',
        { initiation: 'user_asked', title: '线一', ...brief('完成一项') },
        'litch_sessions',
      ),
    )
    const childId = started.thread_id
    assert.ok(childId.startsWith('claude-code'))
    const childTools = env.device.sessionTree.store.tools(childId) as any[]
    assert.equal(
      childTools.some((spec) => spec.name === 'litch_manager'),
      false,
    )
    assert.ok(
      childTools
        .find((spec) => spec.name === 'litch_sessions')
        .instructions.includes('You are a line started by manager'),
    )
    assert.deepEqual(
      (await connection.call('thread/read', { threadId: childId })).thread.litchManager,
      { managerId: manager.id, role: 'line' },
    )
    await assert.rejects(
      startChild(
        env.device.sessionTree,
        childId,
        { kind: 'fresh', title: '孙线', prompt: '任务', wakeParent: true, worktree: false },
        'model',
      ),
      /limit 1/,
    )
    const report = `${'已验证内容。'.repeat(120)}\n没验：真机\nUnverified: packaging`
    env.claude.end(childId, 'completed', report)
    await until(() => env.device.managers.store.report(childId)?.text === report, '完整回报持久化')
    const board = (await connection.call(MANAGER_METHOD.boardRead, { managerId: manager.id })).board
    assert.equal(board.lines[0].report.text, report)
    assert.deepEqual(board.lines[0].unverified, ['没验：真机', 'Unverified: packaging'])
    const next = await startChild(
      env.device.sessionTree,
      childId,
      { kind: 'fresh', title: '孙线', prompt: '任务', wakeParent: true, worktree: false },
      'model',
    )
    assert.equal(env.device.managers.lines.mark(next.threadId)?.role, 'line')
    assert.equal(
      env.device.sessionTree.store
        .tools(next.threadId)
        ?.some((spec: any) => spec.name === 'litch_manager'),
      false,
    )
    const restart = await connection.fails('turn/start', {
      threadId: childId,
      input: [{ type: 'text', text: '重跑', text_elements: [] }],
    })
    assert.equal(restart.data.litch, 'lineLimitReached')
  } finally {
    await env.close()
  }
})

test('经理答复：忙时插入、闲时开回合、结束幂等且看板立即只读，不自动归档线', async () => {
  const env = treeRig()
  try {
    const connection = await client(env)
    const { manager, threadId } = await create(env, connection, { firstTask: '执行第一件事' })
    assert.equal((env.pi.current(threadId)?.items[0]?.content as any)?.[0]?.text, '执行第一件事')
    value(
      await tool(env, threadId, 'add', {
        kind: 'decision',
        decision: { title: '甲？', background: '' },
      }),
    )
    value(
      await tool(env, threadId, 'add', {
        kind: 'decision',
        decision: { title: '乙？', background: '' },
      }),
    )
    const turnId = env.pi.current(threadId)?.id
    const submit = (id: string) =>
      connection.call(MANAGER_METHOD.answersSubmit, {
        managerId: manager.id,
        answers: [{ decisionId: id, revision: 1, optionId: null, text: '同意' }],
      })
    assert.equal((await submit('D-1')).delivery, 'queued')
    await until(() => env.device.managers.store.deliveries(manager.id).length === 0, '答复插话送达')
    assert.equal(env.pi.current(threadId)?.id, turnId)
    assert.equal(
      parseSessionEvent((env.pi.current(threadId)?.items.at(-1)?.content as any)?.[0]?.text).event
        ?.kind,
      'manager-answers',
    )
    env.pi.end(threadId, 'completed', '已处理')
    assert.equal((await submit('D-2')).accepted.length, 1)
    await until(
      () => env.pi.running(threadId) && env.pi.current(threadId)?.id !== turnId,
      '闲时答复开回合',
    )
    env.pi.end(threadId, 'completed', '已处理第二项')
    const line = await startChild(
      env.device.sessionTree,
      threadId,
      { kind: 'fresh', title: '未完成线', prompt: '工作', wakeParent: false, worktree: false },
      'model',
    )
    await connection.call(MANAGER_METHOD.end, { managerId: manager.id })
    await until(() => env.pi.running(threadId), '结束回合')
    const endTurn = env.pi.current(threadId)?.id
    assert.equal(
      parseSessionEvent((env.pi.current(threadId)?.items[0]?.content as any)?.[0]?.text).event
        ?.kind,
      'manager-end',
    )
    await connection.call(MANAGER_METHOD.end, { managerId: manager.id })
    assert.equal(env.pi.current(threadId)?.id, endTurn)
    assert.equal(env.pi.running(line.threadId), true)
    assert.equal(env.pi.thread(line.threadId).archived, undefined)
    assert.equal((await tool(env, threadId, 'status', { text: '不能改' })).success, false)
    assert.equal(
      (await connection.fails(MANAGER_METHOD.update, { managerId: manager.id, name: '不能改' }))
        .data.litch,
      'managerEnded',
    )
  } finally {
    await env.close()
  }
})

test('Codex 经理规则：恢复和分叉按 CURRENT 重拼，保留用户底子及手写规矩', async () => {
  const env = treeRig()
  try {
    const connection = await client(env)
    const { manager, threadId } = await create(env, connection)
    const store = env.device.sessionTree.store
    const context = {
      store,
      ask: async () => ({ config: { developer_instructions: 'project rules' } }),
      log: () => {},
    }
    const started = await prepareInstructions(
      'thread/start',
      { cwd: env.stateDir, dynamicTools: managerTools(manager) },
      context,
    )
    assert.ok(started)
    started.remember({ thread: { id: threadId, cwd: env.stateDir } })
    for (const method of ['thread/resume', 'thread/fork']) {
      const prepared = await prepareInstructions(method, { threadId }, context)
      assert.ok(prepared)
      const text = String(prepared.params.developerInstructions)
      assert.ok(text.includes('project rules'))
      assert.ok(text.includes('Manager sessions'))
      assert.ok(text.includes('You are a Litch manager'))
      assert.ok(text.includes(manager.rules))
      assert.equal(text.includes('Suggested tasks (Litch)'), false)
      prepared.remember({ thread: { id: 'fork-manager', cwd: env.stateDir } })
    }
    assert.ok(
      store.instructions('fork-manager')?.namespaces.some((one) => one.name === 'litch_manager'),
    )
  } finally {
    await env.close()
  }
})
