import assert from 'node:assert/strict'
import test from 'node:test'
import { ATTACHMENT_WATCH_METHOD } from '../../protocol/src/file-attachments.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { ManagerResets } from '../src/manager-reset.mjs'
import { managerBundle, managerFingerprint } from '../src/manager-rules.mjs'
import { startChild } from '../src/session-start.mjs'
import { rig } from './helpers.mjs'
import { treeRig, until } from './tree-kit.mjs'

async function setup(harness = 'pi', values: Record<string, unknown> = {}) {
  const env = treeRig({}, { values })
  const client = env.connect()
  await client.initialize(['harness', 'litchManager', 'sessionTree', 'fileAttachments'])
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

const residentNames = ['litch_browser', 'litch_computer', 'litch_machine', 'litch_tasks']
const enabled = { 'tools.browser': true, 'tools.computer': true, 'tools.machine': true }

function legacyTools(env: Awaited<ReturnType<typeof setup>>): unknown[] {
  const tools = env.device.sessionTree.store
    .tools(env.oldId)!
    .filter((tool: any) => !residentNames.includes(tool.name))
  env.device.sessionTree.store.setTools(env.oldId, tools)
  env.engine.threads.find((thread) => thread.id === env.oldId)!.dynamicTools = tools
  return tools
}

test('旧 Claude 经理重置补齐四类工具并落库，下一回合可调用；角色包不变', async () => {
  const env = await setup('claude-code', enabled)
  try {
    const oldTools = legacyTools(env)
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(
      () => env.device.managers.manager(env.manager.id).reset?.phase === 'ready',
      '旧经理补齐工具',
      5000,
    )
    const tools = env.device.sessionTree.store.tools(env.oldId)! as {
      name: string
      tools: { name: string }[]
    }[]
    assert.deepEqual(
      tools.filter((tool) => !residentNames.includes(tool.name)),
      oldTools,
    )
    for (const name of residentNames)
      assert.ok(
        tools.some((tool) => tool.name === name),
        name,
      )
    assert.deepEqual(
      env.engine.threads.find((thread) => thread.id === env.oldId)!.dynamicTools,
      tools,
    )
    const desktop = env.connect()
    await desktop.initialize(['harness', 'clientTools'], {
      litchClientTools: { namespaces: residentNames.slice(0, 3) },
    })
    await desktop.call('turn/start', { threadId: env.oldId, input: [] })
    for (const [namespace, tool] of [
      ['litch_browser', 'tabs'],
      ['litch_computer', 'list_apps'],
      ['litch_machine', 'machines'],
    ]) {
      assert.ok(
        tools.find((spec) => spec.name === namespace)?.tools.some((spec) => spec.name === tool),
      )
      const called = env.engine.callTool(env.oldId, namespace!, tool!, {})
      const request = await desktop.waitFor((frame) => frame.method === 'item/tool/call')
      desktop.answer(request.id, { success: true, contentItems: [] })
      assert.equal((await called)?.answer.result.success, true)
      desktop.requests.length = 0
    }
    assert.equal(
      (await env.engine.callTool(env.oldId, 'litch_tasks', 'list', {}))?.answer.result.success,
      true,
    )
  } finally {
    await env.close()
  }
})

test('Claude 重置按最新设备和 harness 开关移除已有工具，保留定时任务与角色包', async () => {
  const env = await setup('claude-code', enabled)
  try {
    const before = env.device.sessionTree.store.tools(env.oldId)!
    env.control!.patch({
      values: {
        ...enabled,
        'tools.machine': false,
        'harness.claude-code.browser': false,
        'harness.claude-code.computer': false,
      } as never,
    })
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(
      () => env.device.managers.manager(env.manager.id).reset?.phase === 'ready',
      '关闭工具后重置',
      5000,
    )
    assert.deepEqual(
      env.device.sessionTree.store.tools(env.oldId),
      before.filter((tool: any) => !residentNames.slice(0, 3).includes(tool.name)),
    )
  } finally {
    await env.close()
  }
})

test('进行中回合重置先等待，结束后按此时的开关补齐工具', async () => {
  const env = await setup('claude-code')
  try {
    const oldTools = legacyTools(env)
    await env.client.call('turn/start', { threadId: env.oldId, input: [] })
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    assert.equal(env.device.managers.manager(env.manager.id).reset?.phase, 'waiting')
    assert.deepEqual(env.device.sessionTree.store.tools(env.oldId), oldTools)
    env.control!.patch({ values: enabled as never })
    env.engine.end(env.oldId, 'completed', '当前回合结束')
    await until(
      () => env.device.managers.manager(env.manager.id).reset?.phase === 'ready',
      '回合结束后刷新',
      5000,
    )
    const tools = env.device.sessionTree.store.tools(env.oldId)! as { name: string }[]
    for (const name of residentNames)
      assert.ok(
        tools.some((tool) => tool.name === name),
        name,
      )
  } finally {
    await env.close()
  }
})

for (const harness of ['claude-code', 'pi']) {
  for (const path of ['reconnect', 'restart'] as const) {
    test(`${harness} 旧经理${path}恢复：补齐四类工具，关闭时移除常驻工具，角色不变`, async () => {
      const env = await setup(harness, enabled)
      let restarted: ReturnType<typeof rig> | undefined
      try {
        const oldTools = legacyTools(env)
        env.client.close()
        if (path === 'restart') {
          await env.device.close()
          restarted = rig(
            { [harness]: env.engine },
            {},
            {
              stateDir: env.stateDir,
              clientToolSettings: enabled,
            },
          )
        }
        const current = restarted ?? env
        const client = current.connect()
        await client.initialize(['harness', 'litchManager'])
        if (path === 'restart') {
          // 设备重启续做与内部唤醒通过同一个 EngineLink 恢复入口。
          const link = await current.device.sessionTree.link(harness)
          await link.request('thread/resume', { threadId: env.oldId })
        } else await client.call('thread/resume', { threadId: env.oldId, dynamicTools: [] })
        let tools = current.device.sessionTree.store.tools(env.oldId)! as { name: string }[]
        for (const name of residentNames)
          assert.ok(
            tools.some((tool) => tool.name === name),
            name,
          )
        assert.deepEqual(
          tools.filter((tool) => !residentNames.includes(tool.name)),
          oldTools,
        )
        if (path === 'reconnect') {
          env.control!.patch({
            values: {
              'tools.browser': false,
              'tools.computer': false,
              'tools.machine': false,
            } as never,
          })
          await client.call('thread/resume', { threadId: env.oldId })
          tools = env.device.sessionTree.store.tools(env.oldId)! as { name: string }[]
          assert.deepEqual(
            tools.filter((tool) => tool.name !== 'litch_tasks'),
            oldTools,
          )
          assert.ok(tools.some((tool) => tool.name === 'litch_tasks'))
        }
      } finally {
        await restarted?.device.close()
        await env.close()
      }
    })
  }
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
    const bundle = managerBundle(managers.manager(env.manager.id), false)
    const bundleNames = new Set(bundle.map((spec) => spec.name))
    const installedTools = installed as { name: string }[]
    assert.deepEqual(
      installedTools.filter((spec) => bundleNames.has(spec.name)),
      bundle,
    )
    for (const name of ['litch_browser', 'litch_tasks'])
      assert.ok(installedTools.some((spec) => spec.name === name))
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
    legacyTools(env)
    env.control!.patch({ values: enabled as never })
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
    const installed = tree.store.tools(current.threadId)! as { name: string }[]
    for (const name of residentNames)
      assert.ok(
        installed.some((tool) => tool.name === name),
        name,
      )
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

test('Claude 刷新中断后先恢复旧定义，开关开启也不改写回滚快照', async () => {
  const env = await setup('claude-code', enabled)
  try {
    const oldTools = legacyTools(env)
    const managers = env.device.managers
    const applied = managers.manager(env.manager.id).reset!.applied
    managers.store.saveReset({
      managerId: env.manager.id,
      oldThreadId: env.oldId,
      phase: 'applying',
      applied,
      oldTools,
    })
    managers.resets.tick(env.manager.id)
    await until(
      () => managers.manager(env.manager.id).reset?.phase === 'failed',
      '恢复旧定义',
      5000,
    )
    assert.deepEqual(env.device.sessionTree.store.tools(env.oldId), oldTools)
    assert.deepEqual(
      env.engine.threads.find((thread) => thread.id === env.oldId)!.dynamicTools,
      oldTools,
    )
    assert.equal(managers.manager(env.manager.id).reset?.applied, applied)
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

test('Claude 后台任务持续运行仍完成刷新，不等待旁问、目标或后台接续', async () => {
  const env = await setup('claude-code')
  try {
    const tree = env.device.sessionTree
    tree.host.backgroundRunning = () => 1
    tree.host.continuationPending = () => true
    env.device.managers.questions.busy = () => true
    const link = await tree.link('claude-code')
    assert.ok(link.runtime)
    link.runtime.features = { goals: true }
    env.engine.handlers['thread/goal/get'] = () => {
      assert.fail('Claude 刷新不要求暂停目标')
    }
    const managers = env.device.managers
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(
      () => managers.manager(env.manager.id).reset?.phase === 'ready',
      '后台仍运行时完成',
      5000,
    )
  } finally {
    await env.close()
  }
})

for (const harness of ['claude-code', 'pi']) {
  test(`${harness} 等待期间订阅、附件监听放行，插话取消等待且正文只提交一次`, async () => {
    const env = await setup(harness)
    try {
      const { turn } = await env.client.call('turn/start', { threadId: env.oldId, input: [] })
      await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
      await env.client.call('thread/resume', { threadId: env.oldId })
      await env.client.call(ATTACHMENT_WATCH_METHOD, { threadId: env.oldId, open: true })
      assert.equal(env.device.managers.manager(env.manager.id).reset?.phase, 'waiting')
      const input = [{ type: 'text', text: '继续完成用户的消息', text_elements: [] }]
      await env.client.call('turn/steer', { threadId: env.oldId, expectedTurnId: turn.id, input })
      assert.equal(env.device.managers.manager(env.manager.id).reset?.phase, 'idle')
      assert.equal(
        env.engine
          .current(env.oldId)
          ?.items.filter((item) => JSON.stringify(item.content) === JSON.stringify(input)).length,
        1,
      )
      await env.client.call(ATTACHMENT_WATCH_METHOD, { threadId: env.oldId, open: false })
    } finally {
      await env.close()
    }
  })

  test(`${harness} 取消或新消息可抢占正在查询空闲状态的重置，迟到结果不能恢复重置`, async () => {
    for (const action of ['cancel', 'start']) {
      const env = await setup(harness)
      let release!: () => void
      try {
        const tree = env.device.sessionTree
        const read = tree.read.bind(tree)
        let entered = false
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        tree.read = async (...args) => {
          const result = await read(...args)
          if (args[0] === env.oldId && !entered) {
            entered = true
            await gate
          }
          return result
        }
        await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
        await until(() => entered, '重置正在查空闲')
        const input = [{ type: 'text', text: '不能丢失的新消息', text_elements: [] }]
        if (action === 'cancel') {
          await env.client.call(MANAGER_METHOD.resetCancel, { managerId: env.manager.id })
          await env.client.call(MANAGER_METHOD.resetCancel, { managerId: env.manager.id })
        } else await env.client.call('turn/start', { threadId: env.oldId, input })
        release()
        await env.device.managers.resets.close()
        assert.equal(env.device.managers.manager(env.manager.id).reset?.phase, 'idle')
        assert.equal(env.device.managers.manager(env.manager.id).threadId, env.oldId)
        if (action === 'start')
          assert.deepEqual(env.engine.current(env.oldId)?.items[0]?.content, input)
      } finally {
        release?.()
        await env.close()
      }
    }
  })
}

test('换会话模式仍等待后台任务，但等待可取消；摘要开始后取消明确失败', async () => {
  const env = await setup()
  try {
    let background = 1
    env.device.sessionTree.host.backgroundRunning = () => background
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await env.client.call('thread/resume', { threadId: env.oldId })
    assert.equal(env.device.managers.manager(env.manager.id).reset?.phase, 'waiting')
    await env.client.call(MANAGER_METHOD.resetCancel, { managerId: env.manager.id })
    background = 0
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await until(() => env.engine.running(env.oldId), '摘要开始', 5000)
    await assert.rejects(
      env.client.call(MANAGER_METHOD.resetCancel, { managerId: env.manager.id }),
      (error: any) => error.data?.litch === 'managerResetBusy',
    )
    await env.client.call('thread/resume', { threadId: env.oldId })
    await env.client.call(ATTACHMENT_WATCH_METHOD, { threadId: env.oldId, open: true })
  } finally {
    await env.close()
  }
})

test('设备重启仍在 waiting 时可订阅，回合结束后后台任务不阻止 Claude 刷新', async () => {
  const env = await setup('claude-code')
  let restarted: ReturnType<typeof rig> | undefined
  try {
    await env.client.call('turn/start', { threadId: env.oldId, input: [] })
    await env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id })
    await env.device.close()
    restarted = rig({ 'claude-code': env.engine }, {}, { stateDir: env.stateDir })
    restarted.device.sessionTree.host.backgroundRunning = () => 1
    const client = restarted.connect()
    await client.initialize(['harness', 'litchManager', 'fileAttachments'])
    await client.call('thread/resume', { threadId: env.oldId })
    await client.call(ATTACHMENT_WATCH_METHOD, { threadId: env.oldId, open: true })
    assert.equal(restarted.device.managers.manager(env.manager.id).reset?.phase, 'waiting')
    env.engine.end(env.oldId, 'completed', '重启后回合结束')
    await until(
      () => restarted!.device.managers.manager(env.manager.id).reset?.phase === 'ready',
      '恢复刷新',
      5000,
    )
    await client.call('turn/start', { threadId: env.oldId, input: [] })
  } finally {
    await restarted?.device.close()
    await env.close()
  }
})

test('设备重启自动续做持久化 waiting，未有客户端连接也完成刷新', async () => {
  const env = await setup('claude-code')
  let restarted: ReturnType<typeof rig> | undefined
  try {
    const previous = env.device.managers.store.reset(env.manager.id)
    env.device.managers.store.saveReset({
      managerId: env.manager.id,
      oldThreadId: env.oldId,
      phase: 'waiting',
      applied: previous?.applied ?? null,
    })
    await env.device.close()
    // 先恢复设备但不建立客户端连接；构造后的微任务读取持久化意图。
    restarted = rig({ 'claude-code': env.engine }, {}, { stateDir: env.stateDir })
    restarted.device.sessionTree.host.backgroundRunning = () => 1
    await until(
      () => restarted?.device.managers.manager(env.manager.id).reset?.phase === 'ready',
      '无需客户端询问的恢复',
      5000,
    )
  } finally {
    await restarted?.device.close()
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
