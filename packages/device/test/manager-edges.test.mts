import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { prepareInstructions } from '../src/codex-instructions.mjs'
import { managerTools } from '../src/manager-rules.mjs'
import { prepareSessionTools } from '../src/session-client-tools.mjs'
import { startChild } from '../src/session-start.mjs'
import { intervalTask } from './task-kit.mjs'
import { refuseSteer, treeRig, until } from './tree-kit.mjs'

async function setup(values?: Record<string, unknown>, harness = 'pi') {
  const env = treeRig({}, values ? { values } : {})
  const engine = harness === 'pi' ? env.pi : env.claude
  engine.handlers['model/list'] = () => ({
    data: [
      {
        id: 'fake',
        model: 'fake',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'high'].map((reasoningEffort) => ({ reasoningEffort })),
      },
    ],
  })
  // 模拟引擎保存用户在 turn/start 上的选择，再由 thread/resume 返回。
  const config = { model: 'fake', reasoningEffort: 'high' }
  const newThread = engine.handlers['thread/start']!
  engine.handlers['thread/start'] = (params, connection) => {
    if (params.config?.model_reasoning_effort)
      config.reasoningEffort = params.config.model_reasoning_effort
    return newThread(params, connection)
  }
  const start = engine.handlers['turn/start']!
  const resume = engine.handlers['thread/resume']!
  engine.handlers['turn/start'] = (params, connection) => {
    if (params.model) config.model = params.model
    if (params.effort) config.reasoningEffort = params.effort
    return start(params, connection)
  }
  engine.handlers['thread/resume'] = (params, connection) => ({
    ...(resume(params, connection) as Record<string, unknown>),
    ...config,
  })
  const client = env.connect()
  await client.initialize(['harness', 'litchManager', 'sessionTree', 'deviceTasks'])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness,
    model: 'fake',
    effort: 'low',
    name: '边界测试',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
  })
  await until(() => engine.running(threadId), '经理开场')
  return { ...env, client, manager, threadId, engine }
}

test('D13：用户修改模型和强度后，看板事件沿用线程当前设置', async () => {
  const env = await setup()
  try {
    const { engine, threadId, client, manager } = env
    assert.equal(
      (engine.seen.filter((frame) => frame.method === 'turn/start').at(-1)?.params as any)?.effort,
      'low',
    )
    engine.end(threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(threadId), '空闲')
    await client.call('turn/start', { threadId, model: 'new-model', effort: 'high', input: [] })
    engine.end(threadId, 'completed', '用户回合结束')
    await until(() => !env.device.sessionTree.isActive(threadId), '用户回合停止')
    env.device.managers.writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '继续？', background: '' },
    })
    await client.call(MANAGER_METHOD.answersSubmit, {
      managerId: manager.id,
      answers: [{ decisionId: 'D-1', revision: 1, optionId: null, text: '继续' }],
    })
    await until(() => engine.running(threadId), '事件回合')
    const request = engine.seen.filter((frame) => frame.method === 'turn/start').at(-1)
      ?.params as any
    assert.equal(request.effort, 'high')
    assert.equal(request.model, 'new-model')
  } finally {
    await env.close()
  }
})

for (const ephemeral of [false, true]) {
  test(`D10：不支持替换工具的经理拒绝${ephemeral ? '侧聊' : '普通分叉'}`, async () => {
    const env = await setup()
    try {
      env.engine.end(env.threadId, 'completed', '完成')
      await assert.rejects(
        env.client.call('thread/fork', {
          threadId: env.threadId,
          ephemeral,
        }),
        { message: /manager.*fork|fork.*manager/i },
      )
    } finally {
      await env.close()
    }
  })
}

test('D09：经理结束后，客户端和设备内部都不能继续写入回合', async () => {
  const env = await setup()
  try {
    const { threadId, engine, manager } = env
    await env.client.call(MANAGER_METHOD.end, { managerId: manager.id })
    engine.end(threadId, 'completed', '原回合结束')
    await until(() => engine.running(threadId), '收尾回合')
    engine.end(threadId, 'completed', '经理收尾')
    await until(() => env.device.managers.manager(manager.id).status === 'ended', '经理已结束')
    await assert.rejects(env.client.call('turn/start', { threadId, input: [] }), {
      message: /ended|read.only/i,
    })
    const link = await env.device.sessionTree.link('pi')
    await assert.rejects(link.request('turn/start', { threadId, input: [] }), /ended|read.only/i)
    const { task } = await env.client.call('litch/task/create', {
      ...intervalTask(env.stateDir),
      target: { kind: 'thread', harness: 'pi', threadId },
    })
    await env.client.call('litch/task/runNow', { id: task.id })
    await until(async () => {
      const { data } = await env.client.call('litch/task/runs/list', { taskId: task.id })
      return data[0]?.status === 'failed'
    }, '定时任务被经理结束闸拒绝')
    const { data } = await env.client.call('litch/task/runs/list', { taskId: task.id })
    assert.match(JSON.stringify(data[0]), /manager.*ended/i)
  } finally {
    await env.close()
  }
})

test('D12：任务卡关闭时，经理 start schema 不再暴露 propose/offer，仍无 wrap_up', async () => {
  const values = { 'harness.pi.taskCards': false, 'tools.computer': true, 'tools.machine': true }
  const env = await setup(values)
  try {
    const tools = env.device.sessionTree.store.tools(env.threadId) as any[]
    for (const name of ['litch_browser', 'litch_computer', 'litch_machine', 'litch_tasks'])
      assert.ok(
        tools.some((tool) => tool.name === name),
        name,
      )
    // 即使上游传入带提卡的旧定义，最后的共享注入入口也必须按当前开关选择。
    const selected = prepareSessionTools(
      { dynamicTools: managerTools(env.manager) },
      'pi',
      { extensions: ['clientTools'] },
      false,
      values,
      { tasks: true },
    ).dynamicTools as any[]
    const selectedSessions = selected.find((tool) => tool.name === 'litch_sessions')
    assert.deepEqual(
      selectedSessions.tools.find((tool: any) => tool.name === 'start').inputSchema.properties
        .initiation.enum,
      ['user_asked'],
    )
    const sessions = tools.find((entry) => entry.name === 'litch_sessions')
    const start = sessions.tools.find((entry: any) => entry.name === 'start')
    assert.deepEqual(start.inputSchema.properties.initiation.enum, ['user_asked'])
    assert.ok(!sessions.tools.some((entry: any) => entry.name === 'wrap_up'))
    assert.doesNotMatch(sessions.instructions, /initiation "propose"/)
    const context = {
      store: env.device.sessionTree.store,
      ask: async () => ({ config: {} }),
      log() {},
    }
    const created = await prepareInstructions('thread/start', { dynamicTools: tools }, context)
    assert.ok(created)
    created.remember({ thread: { id: env.threadId, cwd: env.stateDir } })
    const resumed = await prepareInstructions('thread/resume', { threadId: env.threadId }, context)
    assert.ok(resumed)
    assert.doesNotMatch(String(resumed.params.developerInstructions), /initiation "propose"/)
  } finally {
    await env.close()
  }
})

test('D12：存量经理关任务卡立即拒绝提卡，重置后定义和规则同步关闭', async () => {
  const env = await setup({ 'harness.claude-code.taskCards': true }, 'claude-code')
  try {
    const { manager, threadId, engine } = env
    env.control?.patch({ values: { 'harness.claude-code.taskCards': false } as never })
    await until(() => !env.device.sessionTree.host.taskCards('claude-code'), '任务卡开关同步')
    assert.equal(env.device.managers.manager(manager.id).reset?.outdated, true)
    const result = await engine.callTool(threadId, 'litch_sessions', 'start', {
      title: '建议',
      initiation: 'propose',
      prompt: '任务',
    })
    assert.equal(result?.answer.result.success, false)
    engine.end(threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(threadId), '空闲')
    await env.client.call(MANAGER_METHOD.reset, { managerId: manager.id })
    await until(() => env.device.managers.manager(manager.id).reset?.phase === 'ready', '刷新定义')
    const sessions = (env.device.sessionTree.store.tools(threadId) as any[]).find(
      (tool) => tool.name === 'litch_sessions',
    )
    assert.deepEqual(
      sessions.tools.find((tool: any) => tool.name === 'start').inputSchema.properties.initiation
        .enum,
      ['user_asked'],
    )
    assert.doesNotMatch(sessions.instructions, /initiation "propose"/)
    assert.equal(env.device.managers.manager(manager.id).reset?.outdated, false)
  } finally {
    await env.close()
  }
})

for (const enabled of [false, true]) {
  test(`D11：已有工作线回报队列在总开关 ${enabled} 时仍唤醒经理`, async () => {
    const env = await setup({ 'sessions.enabled': !enabled })
    try {
      const { threadId, engine } = env
      refuseSteer(engine)
      const child = await startChild(
        env.device.sessionTree,
        threadId,
        {
          kind: 'fresh',
          title: '工作线',
          prompt: '工作',
          worktree: false,
          wakeParent: true,
        },
        'model',
      )
      engine.end(child.threadId, 'completed', '工作完成')
      await until(() => env.device.sessionTree.store.notes(threadId).length > 0, '排队回报')
      env.control?.patch({ values: { 'sessions.enabled': enabled } as never })
      await until(() => env.device.sessionTree.host.enabled() === enabled, '已有回报时切换总开关')
      engine.end(threadId, 'completed', '等待回报')
      await until(() => engine.running(threadId), '自动唤醒经理')
      assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
    } finally {
      await env.close()
    }
  })
}

for (const harness of ['pi', 'claude-code']) {
  test(`D10：hand_off ${harness} 清理经理角色或明确拒绝`, async () => {
    const env = await setup(undefined, harness)
    try {
      env.engine.end(env.threadId, 'completed', '完成')
      await until(() => !env.device.sessionTree.isActive(env.threadId), '空闲')
      await env.client.call('turn/start', { threadId: env.threadId, input: [] })
      const result = await env.engine.callTool(env.threadId, 'litch_sessions', 'hand_off', {
        title: '交接',
        remaining_plan: '继续完成任务',
        worktree: false,
      })
      assert.ok(result)
      const response = result.answer.result
      assert.equal(response.success, harness === 'claude-code', JSON.stringify(response))
      if (harness === 'pi') assert.match(JSON.stringify(response), /cannot replace manager tools/)
      else {
        const child = JSON.parse(response.contentItems[0].text).thread_id
        const tools = env.device.sessionTree.store.tools(child) as any[]
        assert.ok(!tools.some((entry) => entry.name === 'litch_manager'))
        assert.doesNotMatch(JSON.stringify(tools), /You are a Litch manager|Manager sessions/)
      }
    } finally {
      await env.close()
    }
  })
}

for (const ephemeral of [false, true]) {
  test(`D10：Claude 普通分叉/侧聊 ${ephemeral} 没有经理或工作线角色`, async () => {
    const env = await setup(undefined, 'claude-code')
    try {
      env.engine.end(env.threadId, 'completed', '完成')
      const { thread } = await env.client.call('thread/fork', { threadId: env.threadId, ephemeral })
      const tools = env.device.sessionTree.store.tools(thread.id) as any[]
      assert.ok(
        !tools.some((entry) => entry.name === 'litch_manager' || entry.name === 'litch_repository'),
      )
      assert.doesNotMatch(
        JSON.stringify(tools),
        /You are a Litch manager|Manager sessions|You are a line started by manager/,
      )
      assert.equal(env.device.managers.lines.mark(thread.id), null)
    } finally {
      await env.close()
    }
  })
}
