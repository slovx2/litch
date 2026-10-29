import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type ManagerCreateParams,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { startChild } from '../src/session-start.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'
import { refuseSteer, treeRig, until } from './tree-kit.mjs'

function settings(cwd: string, harness = 'pi'): ManagerCreateParams {
  return {
    cwd,
    harness,
    model: null,
    effort: null,
    name: '经理',
    scope: '测试',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, maxRunningLines: 1, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: 'Keep the repository authoritative.',
    firstTask: '',
  }
}

test('经理配额：并发 start 只有一项占位成功，不创建悬空会话；失败释放名额', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, settings(env.stateDir))
    await until(() => env.pi.running(threadId), '经理回合')
    const spec = {
      kind: 'fresh' as const,
      title: '工作线',
      prompt: '工作',
      wakeParent: false,
      worktree: false,
    }
    const results = await Promise.allSettled([
      startChild(env.device.sessionTree, threadId, spec, 'model'),
      startChild(env.device.sessionTree, threadId, spec, 'model'),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(env.pi.threads.length, 2)
    const line = env.device.managers.board(manager.id).lines[0]
    assert.ok(line)
    env.pi.end(line.threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(line.threadId), '空闲')
    const background = {
      threadId: line.threadId,
      tasks: [{ id: 'background', kind: 'shell', title: 'background job', status: 'running' }],
      wakesOnFinish: false,
    }
    env.device.background.reportedChanged(background)
    await assert.rejects(startChild(env.device.sessionTree, threadId, spec, 'model'), /limit 1/)
    env.device.background.reportedChanged({ ...background, tasks: [] })
    const original = env.pi.handlers['thread/start']
    assert.ok(original)
    env.pi.handlers['thread/start'] = () => {
      throw new Error('建会话失败')
    }
    await assert.rejects(startChild(env.device.sessionTree, threadId, spec, 'model'), /建会话失败/)
    env.pi.handlers['thread/start'] = original
    const next = await startChild(env.device.sessionTree, threadId, spec, 'model')
    assert.ok(next.threadId)
    // 后台任务和等待输入也占名额，已有运行不因调低限制被打断。
    assert.equal(env.device.managers.manager(manager.id).runningLines, 1)
  } finally {
    await env.close()
  }
})

test('经理答复：不支持插话时保留，回合结束再投递；RPC 重试不重复入队', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, settings(env.stateDir))
    await until(() => env.pi.running(threadId), '开场')
    env.device.managers.writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '决定？', background: '' },
    })
    refuseSteer(env.pi)
    const answers = {
      managerId: manager.id,
      answers: [{ decisionId: 'D-1', revision: 1, optionId: null, text: '继续' }],
    }
    await client.call(MANAGER_METHOD.answersSubmit, answers)
    await until(() => env.pi.seen.some((frame) => frame.method === 'turn/steer'), '尝试插话')
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 1)
    assert.equal((await client.call(MANAGER_METHOD.answersSubmit, answers)).delivery, 'none')
    env.pi.end(threadId, 'completed', '上一轮完成')
    await until(() => env.device.managers.store.deliveries(manager.id).length === 0, '下一轮送达')
    assert.equal(env.pi.turns.get(threadId)?.length, 2)
    const input = env.pi.current(threadId)?.items[0]?.content as any
    assert.equal(parseSessionEvent(input?.[0]?.text ?? '').event?.kind, 'manager-answers')
  } finally {
    await env.close()
  }
})

test('经理事件：重启设备后恢复待投递事件和经理标记', async () => {
  const engine = new FakeEngine('pi')
  const first = rig({ pi: engine })
  let second: ReturnType<typeof rig> | undefined
  try {
    const client = first.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, settings(first.stateDir))
    await until(() => engine.running(threadId), '开场')
    first.device.managers.writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '重启之后？', background: '' },
    })
    // 只落库不 kick，模拟答案已提交、进程尚未开始投递。
    first.device.managers.writer.answers(manager.id, [
      { decisionId: 'D-1', revision: 1, optionId: null, text: '处理' },
    ])
    engine.end(threadId, 'completed', '完成')
    await first.device.close()
    second = rig({ pi: engine }, {}, { stateDir: first.stateDir })
    await until(() => engine.running(threadId), '重启后送达', 5000)
    assert.equal(second.device.managers.store.object(manager.id, 'D-1')?.status, 'answered')
    assert.equal(second.device.managers.lines.mark(threadId)?.role, 'manager')
    await until(
      () => second?.device.managers.store.deliveries(manager.id).length === 0,
      '持久事件出队',
    )
  } finally {
    if (second) await second.close()
    else await first.close()
  }
})

test('原生 Codex：经理 create 经内部连接注入规则，恢复采用更新设置，不发送未知参数', async () => {
  const env = codexRig()
  try {
    env.codex.handlers['config/read'] = () => ({
      config: { developer_instructions: 'Project policy.' },
    })
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(
      MANAGER_METHOD.create,
      settings(env.stateDir, 'codex'),
    )
    const start = sentTo(env.codex, 'thread/start').at(-1)
    assert.ok(start.developerInstructions.includes('Project policy.'))
    assert.ok(start.developerInstructions.includes('You are a Litch manager'))
    assert.ok(start.dynamicTools.some((spec: any) => spec.name === 'litch_manager'))
    assert.equal(
      start.dynamicTools.some((spec: any) => spec.instructions),
      false,
    )
    await client.call(MANAGER_METHOD.update, {
      managerId: manager.id,
      scope: '新的范围',
      rules: 'New custom policy.',
    })
    await client.call('thread/resume', { threadId })
    const resumed = sentTo(env.codex, 'thread/resume').at(-1)
    assert.ok(resumed.developerInstructions.includes('新的范围'))
    assert.ok(resumed.developerInstructions.includes('New custom policy.'))
    assert.equal(resumed.developerInstructions.includes('Suggested tasks (Litch)'), false)
  } finally {
    await env.close()
  }
})

test('经理分叉：Claude 替换工具和角色规则；不能替换的引擎在建会话前明确拒绝', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const made = await client.call(MANAGER_METHOD.create, settings(env.stateDir, 'claude-code'))
    await until(() => env.claude.running(made.threadId), 'Claude 经理开场')
    env.claude.end(made.threadId, 'completed', '计划')
    const spec = {
      kind: 'fork' as const,
      title: '分叉线',
      prompt: '执行',
      wakeParent: false,
      worktree: false,
    }
    const fork = await startChild(env.device.sessionTree, made.threadId, spec, 'model')
    const sent = env.claude.seen.find((frame) => frame.method === 'thread/fork')?.params as any
    assert.ok(sent.dynamicTools)
    assert.equal(
      sent.dynamicTools.some((tool: any) => tool.name === 'litch_manager'),
      false,
    )
    assert.ok(
      sent.dynamicTools
        .find((tool: any) => tool.name === 'litch_sessions')
        .instructions.includes('You are a line'),
    )
    assert.equal(env.device.managers.lines.mark(fork.threadId)?.role, 'line')
    const pi = await client.call(MANAGER_METHOD.create, settings(env.stateDir))
    await until(() => env.pi.running(pi.threadId), 'Pi 经理开场')
    env.pi.end(pi.threadId, 'completed', '计划')
    const count = env.pi.threads.length
    await assert.rejects(
      startChild(env.device.sessionTree, pi.threadId, spec, 'model'),
      /cannot replace manager tools/,
    )
    assert.equal(env.pi.threads.length, count)
  } finally {
    await env.close()
  }
})
