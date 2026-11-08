import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  formatSessionEvent,
  parseSessionEvent,
  SESSION_TREE_LIMITS,
} from '../../protocol/src/session-tree.mjs'
import { startChild } from '../src/session-start.mjs'
import { resultOf } from './fake-engine.mjs'
import { rig } from './helpers.mjs'
import { refuseSteer, treeRig, until } from './tree-kit.mjs'

async function fixture(running = false) {
  const env = treeRig()
  const client = env.connect()
  await client.initialize(['harness', 'sessionTree', 'litchManager'])
  const { manager } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '经理',
    scope: '',
    template: 'blank',
    rules: '',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
  })
  const tree = env.device.sessionTree
  let source = manager.threadId
  for (const title of ['第一层线', '第二层线']) {
    source = (
      await startChild(
        tree,
        source,
        {
          title,
          prompt: '继续工作',
          kind: 'fresh',
          worktree: false,
          wakeParent: false,
        },
        'user',
      )
    ).threadId
  }
  if (!running) {
    env.pi.end(manager.threadId)
    await until(() => !tree.isActive(manager.threadId), '经理空闲')
  }
  await env.device.managers.settleDeliveries(manager.id)
  // 唯一的模型动作是 propose；没有 send，也不结束来源回合。
  const proposeTool = async (title = '修复重复建议') => {
    const reply = await env.pi.callTool(source, 'litch_sessions', 'start', {
      initiation: 'propose',
      title,
      background: `这是值得修的问题。${'后面的细节不用放进通知。'.repeat(8)}`,
      prompt: '实施任务',
      kind: 'fresh',
      worktree: false,
    })
    const id = resultOf(reply?.answer).proposal_id
    assert.equal(typeof id, 'string', JSON.stringify(reply))
    const proposal = tree.proposal(id)
    assert.ok(proposal)
    return proposal
  }
  const propose = (title = '修复重复建议') =>
    tree.propose({
      threadId: source,
      title,
      background: '这是值得修的问题。后面的细节不用放进通知。',
      prompt: '实施任务',
      kind: 'fresh',
      harness: 'pi',
      model: null,
      cwd: env.stateDir,
      wakeParent: false,
    })
  const notices = () =>
    env.pi.seen.filter(
      (r) =>
        r.params?.threadId === manager.threadId &&
        ['turn/start', 'turn/steer'].includes(r.method) &&
        parseSessionEvent(r.params.input?.[0]?.text ?? '').event?.kind === 'manager-suggestions',
    )
  return { ...env, client, manager, source, tree, propose, proposeTool, notices }
}

for (const running of [false, true]) {
  test(`工作线只调用 propose、不 send：平台自动${running ? '插话' : '唤醒'}经理`, async () => {
    const env = await fixture(running)
    try {
      const proposal = await env.proposeTool()
      await until(
        () => env.device.managers.store.deliveries(env.manager.id).length === 0,
        '设备自动投递',
      )
      assert.equal(env.notices().length, 1)
      assert.equal(env.notices()[0]?.method, running ? 'turn/steer' : 'turn/start')
      assert.ok(env.notices()[0]?.params.input[0].text.includes(proposal.id))
      assert.equal(env.pi.running(env.source), true, '来源回合尚未结束')
    } finally {
      await env.close()
    }
  })
  test(`孙线提卡独立通知：经理${running ? '运行时插话' : '空闲时唤醒'}，多卡合并且不等来源结束`, async (t) => {
    const env = await fixture(running)
    try {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const first = await env.propose('第一张'),
        second = await env.propose('第二张')
      assert.equal(env.notices().length, 0)
      assert.equal(
        env.device.managers.store.deliveries(env.manager.id).length,
        2,
        '合并等待前已持久化',
      )
      t.mock.timers.tick(250)
      await env.device.managers.settleDeliveries(env.manager.id)
      assert.equal(env.notices().length, 1)
      const [sent] = env.notices()
      assert.equal(sent?.method, running ? 'turn/steer' : 'turn/start')
      const body = sent?.params.input[0].text as string
      for (const p of [first, second]) {
        assert.ok(body.includes(`S-${p.id.slice(0, 8)}`))
        assert.ok(body.includes(p.id))
        assert.ok(body.includes(p.title))
      }
      assert.match(body, /这是值得修的问题。/)
      assert.doesNotMatch(body, /后面的细节/)
      assert.ok(body.includes(env.source))
      assert.match(body, /第二层线/)
      assert.match(body, /已合入的提交和事项查重/)
      assert.match(body, /endorse.*dismiss/)
      assert.equal(env.pi.running(env.source), true)
      assert.equal(env.tree.store.wakes(env.manager.threadId), running ? 0 : 1)
      assert.equal(env.tree.store.notes(env.manager.threadId).length, 0, '不混入可被覆盖的完成回报')
      assert.equal(env.device.managers.store.deliveries(env.manager.id).length, 0)
      env.device.managers.kick(env.manager.id)
      await env.device.managers.settleDeliveries(env.manager.id)
      assert.equal(env.notices().length, 1, '旧卡不再次通知')
    } finally {
      t.mock.timers.reset()
      await env.close()
    }
  })
}

for (const barrier of ['limit', 'stopped', 'background', 'reset', 'longIdle'] as const) {
  test(`提卡自动唤醒遵守 ${barrier}，拒绝时通知保留，解除后投递`, async (t) => {
    const env = await fixture(barrier === 'stopped')
    try {
      if (barrier === 'limit')
        env.tree.store.setWakes(env.manager.threadId, SESSION_TREE_LIMITS.wakesPerUserMessage)
      if (barrier === 'stopped') {
        env.pi.end(env.manager.threadId, 'interrupted', '用户停止')
        await until(() => !env.tree.isActive(env.manager.threadId), '停止完成')
      }
      if (barrier === 'background')
        env.device.background.reportedChanged({
          threadId: env.manager.threadId,
          tasks: [{ id: 'bg', kind: 'shell', title: '后台', status: 'running' }],
        })
      const held = env.device.managers.resets.held.bind(env.device.managers.resets)
      if (barrier === 'reset') env.device.managers.resets.held = () => true
      if (barrier === 'longIdle') env.tree.host.wakeIdleMs = -1
      t.mock.timers.enable({ apis: ['setTimeout'] })
      await env.propose()
      t.mock.timers.tick(250)
      await env.device.managers.settleDeliveries(env.manager.id)
      assert.equal(env.notices().length, 0)
      assert.equal(env.device.managers.store.deliveries(env.manager.id).length, 1)
      env.tree.store.setWakes(env.manager.threadId, 0)
      env.tree.beforeUserTurn(env.manager.threadId, [])
      env.device.background.reportedChanged({ threadId: env.manager.threadId, tasks: [] })
      env.device.managers.resets.held = held
      env.tree.host.wakeIdleMs = 86400_000
      env.device.managers.kick(env.manager.id)
      await env.device.managers.settleDeliveries(env.manager.id)
      assert.equal(env.notices().length, 1)
    } finally {
      t.mock.timers.reset()
      await env.close()
    }
  })
}

for (const running of [false, true]) {
  for (const state of [
    'endorsed',
    'dismissed',
    'started',
    'withdrawn',
    'expired',
    'accepting',
  ] as const) {
    test(`最终${running ? '插话' : '唤醒'}前过滤 ${state} 卡，保留同批未审核卡`, async (t) => {
      const env = await fixture(running)
      let release: (() => void) | undefined
      try {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const stale = env.propose('即将失效'),
          fresh = env.propose('仍待审核')
        let arrived = () => {}
        const reached = new Promise<void>((resolve) => {
          arrived = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        // 暂停最终发送前的异步等待；恢复之后必须再查状态，不能只在 drain 开始时过滤。
        const method = running ? 'thread/read' : 'thread/resume'
        const handler = env.pi.handlers[method]
        assert.ok(handler)
        env.pi.handlers[method] = async (params, connection) => {
          const value = await handler(params, connection)
          if (params.threadId === env.manager.threadId) {
            arrived()
            await gate
          }
          return value
        }
        t.mock.timers.tick(250)
        await reached
        if (state === 'endorsed' || state === 'dismissed') {
          env.device.managers.store.saveSuggestionReview(env.manager.id, stale.id, {
            state,
            reason: '已处理',
            at: Math.floor(Date.now() / 1000),
          })
        } else if (state === 'accepting') {
          env.tree.accepting.set(
            stale.id,
            Promise.resolve({ threadId: 'starting-child', harness: 'pi' }),
          )
        } else {
          env.tree.settleProposal(stale.id, state, state === 'started' ? 'started-child' : null)
        }
        release?.()
        await env.device.managers.settleDeliveries(env.manager.id)
        assert.equal(env.notices().length, 1)
        const sent = env.notices()[0]?.params.input[0].text as string
        assert.ok(sent.includes(fresh.id))
        assert.ok(!sent.includes(stale.id), '已处理卡不得到达引擎')
        assert.equal(env.device.managers.store.deliveries(env.manager.id).length, 0)
      } finally {
        release?.()
        t.mock.timers.reset()
        await env.close()
      }
    })
  }
}

test('延迟合并期间已审核的单卡不通知、不消耗唤醒预算', async (t) => {
  const env = await fixture()
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const proposal = env.propose()
    env.device.managers.store.saveSuggestionReview(env.manager.id, proposal.id, {
      state: 'endorsed',
      reason: '已核实',
      at: Math.floor(Date.now() / 1000),
    })
    t.mock.timers.tick(250)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.notices().length, 0)
    assert.equal(env.device.managers.store.deliveries(env.manager.id).length, 0)
    assert.equal(env.tree.store.wakes(env.manager.threadId), 0)
  } finally {
    t.mock.timers.reset()
    await env.close()
  }
})

test('引擎等待回合配额期间已审核，写协议前撤销旧批次并保留未审核卡', async (t) => {
  const env = await fixture()
  let release: (() => void) | undefined
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const stale = env.propose('配额等待期间审核'),
      fresh = env.propose('保留新卡')
    let arrived = () => {}
    const reached = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reserve = env.device.managers.lines.reserve.bind(env.device.managers.lines)
    env.device.managers.lines.reserve = async (...args) => {
      const result = await reserve(...args)
      if (args[1] === env.manager.threadId) {
        arrived()
        await gate
      }
      return result
    }
    t.mock.timers.tick(250)
    await reached
    env.device.managers.store.saveSuggestionReview(env.manager.id, stale.id, {
      state: 'endorsed',
      reason: '配额等待期间已审核',
      at: Math.floor(Date.now() / 1000),
    })
    release?.()
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.notices().length, 0, '旧批次不能到达引擎')
    assert.equal(env.tree.store.wakes(env.manager.threadId), 0)
    assert.equal(env.device.managers.store.deliveries(env.manager.id).length, 1)
    env.device.managers.kick(env.manager.id)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.notices().length, 1)
    const body = env.notices()[0]?.params.input[0].text as string
    assert.ok(body.includes(fresh.id) && !body.includes(stale.id))
  } finally {
    release?.()
    t.mock.timers.reset()
    await env.close()
  }
})

test('提卡通知插话失败留队，回合结束后送达，不依赖来源回报', async (t) => {
  const env = await fixture(true)
  try {
    refuseSteer(env.pi)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await env.propose()
    t.mock.timers.tick(250)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.device.managers.store.deliveries(env.manager.id).length, 1)
    t.mock.timers.reset()
    env.pi.end(env.manager.threadId)
    await until(
      () => env.device.managers.store.deliveries(env.manager.id).length === 0,
      '经理下一回合收到',
    )
    assert.equal(env.pi.running(env.source), true)
    assert.equal(env.notices().filter((r) => r.method === 'turn/start').length, 1)
  } finally {
    t.mock.timers.reset()
    await env.close()
  }
})

test('先排队的忽略事件既不能绕过提卡唤醒保护，也不能堵住可投递的建议', async (t) => {
  const env = await fixture()
  try {
    env.tree.store.setWakes(env.manager.threadId, SESSION_TREE_LIMITS.wakesPerUserMessage)
    env.device.managers.store.enqueue(
      env.manager.id,
      formatSessionEvent({
        kind: 'manager-ignored',
        notes: [],
        manager: {
          managerId: env.manager.id,
          text: '忽略待告知',
          ignored: [{ decisionId: 'D-1', title: '旧决策', reason: '' }],
        },
      }),
    )
    t.mock.timers.enable({ apis: ['setTimeout'] })
    env.propose()
    t.mock.timers.tick(250)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.pi.running(env.manager.threadId), false)
    assert.equal(env.notices().length, 0)
    env.tree.store.setWakes(env.manager.threadId, 0)
    env.device.managers.kick(env.manager.id)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.notices().length, 1)
  } finally {
    t.mock.timers.reset()
    await env.close()
  }
})

test('新通知持久保存跨设备重启，旧的未审核卡不补发', async (t) => {
  const env = await fixture()
  let restarted: ReturnType<typeof rig> | undefined
  try {
    env.tree.store.setWakes(env.manager.threadId, SESSION_TREE_LIMITS.wakesPerUserMessage)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const fresh = env.propose('重启前新卡')
    env.tree.store.addProposal({ ...fresh, id: 'old-unreviewed', title: '旧的未审核卡' })
    t.mock.timers.tick(250)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.notices().length, 0)
    t.mock.timers.reset()
    // 假引擎默认 updatedAt=9000；模拟刚结束的真实会话，避免被 24 小时空闲保护正确拦住。
    env.pi.thread(env.manager.threadId).updatedAt = Math.floor(Date.now() / 1000)
    await env.device.close()
    restarted = rig({ pi: env.pi, 'claude-code': env.claude }, {}, { stateDir: env.stateDir })
    assert.equal(restarted.device.managers.store.deliveries(env.manager.id).length, 1)
    restarted.device.sessionTree.store.setWakes(env.manager.threadId, 0)
    restarted.device.managers.kick(env.manager.id)
    await until(
      () => restarted?.device.managers.store.deliveries(env.manager.id).length === 0,
      '重启后引擎就绪并投递持久通知',
    )
    assert.equal(env.notices().length, 1)
    const text = env.notices()[0]?.params.input[0].text as string
    assert.ok(text.includes(fresh.id))
    assert.doesNotMatch(text, /old-unreviewed|旧的未审核卡/)
  } finally {
    t.mock.timers.reset()
    if (restarted) await restarted.close()
    else await env.close()
  }
})

test('经理重置的绑定切换后，待审核通知投给新会话；自动通知不堵住用户答复', async (t) => {
  const env = await fixture()
  try {
    const held = env.device.managers.resets.held.bind(env.device.managers.resets)
    env.device.managers.resets.held = () => true
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const proposal = env.propose()
    t.mock.timers.tick(250)
    await env.device.managers.settleDeliveries(env.manager.id)
    assert.equal(env.notices().length, 0)
    t.mock.timers.reset()
    const next = await env.client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    const manager = env.device.managers.store.manager(env.manager.id)
    assert.ok(manager)
    env.device.managers.store.saveManager({ ...manager, threadId: next.thread.id })
    env.device.managers.resets.held = held
    env.tree.store.setWakes(next.thread.id, SESSION_TREE_LIMITS.wakesPerUserMessage)
    env.device.managers.writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '继续？', background: '' },
    })
    env.device.managers.writer.answers(manager.id, [
      { decisionId: 'D-1', revision: 1, optionId: null, text: '继续' },
    ])
    env.device.managers.kick(manager.id)
    await env.device.managers.settleDeliveries(manager.id)
    assert.equal(env.pi.running(next.thread.id), true, '用户答复仍能开回合')
    assert.equal(env.notices().length, 0, '不向旧经理投递')
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 1, '尚未送出的建议仍保留')
    env.device.managers.kick(manager.id)
    await env.device.managers.settleDeliveries(manager.id)
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 0)
    const notices = env.pi
      .sent('turn/steer')
      .filter((p) => p.threadId === next.thread.id && p.input[0].text.includes(proposal.id))
    assert.equal(notices.length, 1)
  } finally {
    t.mock.timers.reset()
    await env.close()
  }
})
