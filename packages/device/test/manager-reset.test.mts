import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { ManagerResets } from '../src/manager-reset.mjs'
import { managerBundle, managerFingerprint } from '../src/manager-rules.mjs'
import { startChild } from '../src/session-start.mjs'
import { treeRig, until } from './tree-kit.mjs'

async function setup(harness = 'pi') {
  const env = treeRig()
  const client = env.connect()
  await client.initialize(['harness', 'litchManager', 'sessionTree'])
  const result = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness,
    model: null,
    effort: null,
    name: '重置测试',
    scope: '测试',
    rules: '',
    template: 'blank',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
    firstTask: '',
  })
  const engine = harness === 'pi' ? env.pi : env.claude
  engine.handlers['thread/name/set'] = () => ({})
  await until(() => engine.running(result.threadId), '开场')
  engine.end(result.threadId, 'completed', '原始历史')
  await until(() => !env.device.sessionTree.isActive(result.threadId), '空闲')
  return { ...env, client, engine, manager: result.manager, oldId: result.threadId as string }
}

test('能力指纹稳定，创建已安装；设置和工具变化均显示落后', async () => {
  const env = await setup()
  try {
    const managers = env.device.managers
    assert.equal(managers.manager(env.manager.id).reset?.outdated, false)
    const first = managers.manager(env.manager.id)
    const elsewhere = { ...first, threadId: 'elsewhere' }
    assert.equal(
      managerFingerprint(managerBundle(first, false)),
      managerFingerprint(managerBundle(elsewhere, false)),
    )
    await env.client.call(MANAGER_METHOD.update, { managerId: first.id, rules: '新规矩' })
    assert.equal(managers.manager(first.id).reset?.outdated, true)
  } finally {
    await env.close()
  }
})

test('Claude 原地替换完整工具和指令，保持线程、历史和看板', async () => {
  const env = await setup('claude-code')
  try {
    const managers = env.device.managers
    const oldTurns = structuredClone(env.engine.turns.get(env.oldId))
    let installed: unknown
    const resume = env.engine.handlers['thread/resume']!
    env.engine.handlers['thread/resume'] = (params, connection) => {
      if (params.dynamicTools) installed = params.dynamicTools
      return resume(params, connection)
    }
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(() => managers.manager(env.manager.id).reset?.phase === 'ready', '原地刷新', 5000)
    assert.equal(managers.manager(env.manager.id).threadId, env.oldId)
    assert.deepEqual(env.engine.turns.get(env.oldId), oldTurns)
    assert.deepEqual(installed, managerBundle(managers.manager(env.manager.id), false))
    assert.deepEqual(env.device.sessionTree.store.tools(env.oldId), installed)
    assert.equal(managers.manager(env.manager.id).reset?.outdated, false)
  } finally {
    await env.close()
  }
})

test('换绑保留看板、子树、停报偏好和待投递回报，旧经理全部工具与新回合被拒', async () => {
  const env = await setup()
  try {
    const managers = env.device.managers
    const tree = env.device.sessionTree
    const child = await startChild(
      tree,
      env.oldId,
      { kind: 'fresh', title: '运行线', prompt: '工作', wakeParent: false, worktree: false },
      'model',
    )
    const before = structuredClone(tree.store.parentOf(child.threadId))
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(() => env.engine.running(env.oldId), '摘要开始', 5000)
    env.engine.end(child.threadId, 'completed', '线已完成')
    await until(() => tree.store.notes(env.oldId).length === 1, '排队回报')
    env.engine.end(env.oldId, 'completed', '交接：验收运行线')
    await until(
      () => {
        const state = managers.manager(env.manager.id)
        assert.notEqual(state.reset?.phase, 'failed', JSON.stringify(state.reset))
        return state.threadId !== env.oldId
      },
      '换绑提交',
      5000,
    )
    const current = managers.manager(env.manager.id)
    assert.equal(managers.store.forThread(env.oldId), null)
    assert.equal(managers.store.forThread(current.threadId)?.id, current.id)
    assert.deepEqual(current.historyThreadIds, [env.oldId])
    assert.equal(tree.store.parentOf(child.threadId)?.parentThreadId, current.threadId)
    assert.equal(tree.store.parentOf(child.threadId)?.wakeParent, before?.wakeParent)
    assert.equal(tree.store.parentOf(child.threadId)?.reportEpoch, before?.reportEpoch)
    assert.equal(tree.store.notes(env.oldId).length, 0)
    assert.ok(
      tree.store.notes(current.threadId).length === 1 ||
        JSON.stringify(env.engine.turns.get(current.threadId)).includes('线已完成'),
    )
    assert.equal(managers.board(current.id).lines[0]?.threadId, child.threadId)
    assert.equal(managers.board(current.id).lines[0]?.report?.text, '线已完成')
    await assert.rejects(
      env.client.call('turn/start', { threadId: env.oldId, input: [] }),
      (error: any) => /read-only.*current manager/.test(error.message),
    )
    await assert.rejects(env.client.call('thread/resume', { threadId: env.oldId }), (error: any) =>
      /read-only/.test(error.message),
    )
    const read = await env.client.call('thread/read', { threadId: env.oldId, includeTurns: true })
    assert.ok(read.thread.turns.length > 0)
    for (const [namespace, tool] of [
      ['litch_manager', 'add'],
      ['litch_sessions', 'send'],
      ['litch_sessions', 'respond'],
      ['litch_sessions', 'start'],
    ]) {
      const reply = await env.engine.callTool(env.oldId, namespace!, tool!, {})
      assert.equal(reply?.answer.result.success, false)
      assert.match(JSON.stringify(reply?.answer.result), new RegExp(current.threadId))
    }
  } finally {
    await env.close()
  }
})

test('候选创建失败不改绑定、父链和队列；摘要失败必须再次确认才可只靠看板', async () => {
  const env = await setup()
  try {
    const managers = env.device.managers
    const before = managers.store.manager(env.manager.id)
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(() => env.engine.running(env.oldId), '摘要', 5000)
    env.engine.end(env.oldId, 'failed', '')
    await until(
      () => managers.manager(env.manager.id).reset?.phase === 'summaryFailed',
      '摘要失败',
      5000,
    )
    assert.deepEqual(managers.store.manager(env.manager.id), before)
    env.engine.handlers['thread/start'] = () => {
      throw new Error('injected create failure')
    }
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id, boardOnly: true })
    await until(() => managers.manager(env.manager.id).reset?.phase === 'failed', '候选失败', 5000)
    assert.deepEqual(managers.store.manager(env.manager.id), before)
    assert.deepEqual(managers.store.history(env.manager.id), [])
  } finally {
    await env.close()
  }
})

test('经理忙时等待，后台结束后刷新；工作线不需要停下', async () => {
  const env = await setup('claude-code')
  try {
    const tree = env.device.sessionTree
    let background = 1
    tree.host.backgroundRunning = (id) => (id === env.oldId ? background : 0)
    const managers = env.device.managers
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    assert.equal(managers.manager(env.manager.id).reset?.phase, 'waiting')
    await assert.rejects(env.client.call('turn/start', { threadId: env.oldId, input: [] }))
    background = 0
    await until(
      () => managers.manager(env.manager.id).reset?.phase === 'ready',
      '后台空闲后完成',
      5000,
    )
  } finally {
    await env.close()
  }
})

test('Claude 更新失败恢复旧定义，不改变经理绑定与历史', async () => {
  const env = await setup('claude-code')
  try {
    const tree = env.device.sessionTree
    const managers = env.device.managers
    const oldTools = [{ type: 'namespace', name: 'litch_old', tools: [] }]
    tree.store.setTools(env.oldId, oldTools)
    const resume = env.engine.handlers['thread/resume']!
    let restored = false
    env.engine.handlers['thread/resume'] = (params, connection) => {
      if (params.dynamicTools && params.dynamicTools[0]?.name !== 'litch_old')
        throw new Error('injected refresh failure')
      if (params.dynamicTools) restored = true
      return resume(params, connection)
    }
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(() => managers.manager(env.manager.id).reset?.phase === 'failed', '回滚确认', 5000)
    assert.equal(restored, true)
    assert.deepEqual(tree.store.tools(env.oldId), oldTools)
    assert.equal(managers.manager(env.manager.id).threadId, env.oldId)
  } finally {
    await env.close()
  }
})

test('提交意图恢复可重复：父链与两份经理索引一致，接班消息只排一次', async () => {
  const env = await setup()
  try {
    const managers = env.device.managers
    const tree = env.device.sessionTree
    const child = await startChild(
      tree,
      env.oldId,
      { kind: 'fresh', title: '线', prompt: '工作', wakeParent: false, worktree: false },
      'model',
    )
    const after = { ...managers.store.manager(env.manager.id)!, threadId: 'recovered-manager' }
    managers.store.enqueue(after.id, '重置期间的用户答复')
    managers.store.saveReset({
      managerId: after.id,
      oldThreadId: env.oldId,
      phase: 'applying',
      applied: 'fingerprint',
      committed: { manager: after, input: '接班' },
    })
    // 模拟会话库已提交而经理库尚未完成的进程退出窗口。
    tree.store.rebindManager(env.oldId, after.threadId)
    const recovered = new ManagerResets(managers)
    const second = new ManagerResets(managers)
    assert.equal(managers.store.deliveries(after.id)[0]?.text, '接班')
    assert.ok(
      managers.store.deliveries(after.id).some((event) => event.text === '重置期间的用户答复'),
    )
    assert.equal(managers.store.forThread(after.threadId)?.id, after.id)
    assert.equal(managers.store.forThread(env.oldId), null)
    assert.equal(tree.store.parentOf(child.threadId)?.parentThreadId, after.threadId)
    assert.equal(
      managers.store.deliveries(after.id).filter((entry) => entry.text === '接班').length,
      1,
    )
    await recovered.close()
    await second.close()
  } finally {
    await env.close()
  }
})

test('候选命名或提交意图落盘失败：不换绑，重启也不能误提交失败的候选', async () => {
  for (const stage of ['name', 'intent']) {
    const env = await setup()
    try {
      const managers = env.device.managers
      const before = managers.store.manager(env.manager.id)
      if (stage === 'name')
        env.engine.handlers['thread/name/set'] = () => {
          throw new Error('injected name failure')
        }
      else {
        const save = managers.store.saveReset.bind(managers.store)
        managers.store.saveReset = (record) => {
          if (record.committed) throw new Error('injected precommit failure')
          save(record)
        }
      }
      await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
      await until(() => env.engine.running(env.oldId), '摘要开始', 5000)
      env.engine.end(env.oldId, 'completed', '交接摘要')
      await until(() => managers.manager(env.manager.id).reset?.phase === 'failed', stage, 5000)
      assert.deepEqual(managers.store.manager(env.manager.id), before)
      assert.equal(managers.store.reset(env.manager.id)?.committed, undefined)
      const recovered = new ManagerResets(managers)
      assert.deepEqual(managers.store.manager(env.manager.id), before)
      await recovered.close()
    } finally {
      await env.close()
    }
  }
})
