// 使用隔离的协议对端：没有用户回合时，设备的自动回合也必须立即读到新设置。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcFailure } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { runtimeInfo, setup, watch, where } from './world.mjs'

function fixture(engine: string, beforeWrite?: () => Promise<void>, remote = false) {
  const saved = {
    model: 'small',
    reasoningEffort: 'low',
    serviceTier: 'default',
    activePermissionProfile: ':workspace',
    collaborationMode: { mode: 'default' },
  }
  const world = setup(
    undefined,
    {
      'runtime/info': () => runtimeInfo({ engine }),
      'thread/resume': () => ({ thread: thread({ id: 'a', turns: [] }), ...saved }),
      'thread/settings/update': async (params) => {
        await beforeWrite?.()
        const p = params as Record<string, any>
        if (p.model) saved.model = p.model
        if (p.effort) saved.reasoningEffort = p.effort
        if (p.serviceTier) saved.serviceTier = p.serviceTier
        if (p.permissions) saved.activePermissionProfile = p.permissions
        if (p.collaborationMode) saved.collaborationMode = p.collaborationMode
        return {}
      },
    },
    undefined,
    remote ? 'ssh' : 'local',
  )
  return { ...world, saved }
}

for (const remote of [false, true])
  for (const engine of ['codex', 'claude', 'pi', 'dsh', 'opencode', 'acp']) {
    test(`${engine}/${remote ? '远程' : '本机'}：切换立即持久化；自动回合与重连不依赖下一条用户消息`, async () => {
      const world = fixture(engine, undefined, remote)
      world.core.start()
      try {
        await settle()
        const session = watch(world.core)
        await settle()
        await world.command('session.configure', {
          ...where,
          settings: {
            model: 'large',
            effort: 'high',
            speed: 'priority',
            permission: ':danger-full-access',
            mode: 'plan',
          },
        })
        assert.equal(world.sent('turn/start').length, 0)
        assert.deepEqual(
          world.saved,
          {
            model: 'large',
            reasoningEffort: 'high',
            serviceTier: 'priority',
            activePermissionProfile: ':danger-full-access',
            collaborationMode: {
              mode: 'plan',
              settings: { model: 'large', reasoning_effort: 'high', developer_instructions: null },
            },
          },
          '设备定时任务、回报及后台唤醒读取的是引擎设置，不是客户端草稿',
        )
        assert.equal(world.sent('thread/settings/update').length, 1)
        world.peer.last().drop()
        await settle()
        world.time.advance(500)
        await settle()
        await settle()
        assert.equal(session.seen.view?.settings.effort, 'high')
        assert.equal(session.seen.view?.settings.permission, ':danger-full-access')
        await world.command('session.send', { ...where, text: '用户随后发送' })
        const sent = world.sent('turn/start')[0] as Record<string, unknown>
        assert.equal(sent.effort, undefined, '不再靠用户回合补写设置')
      } finally {
        world.core.stop()
      }
    })
  }

test('写入失败不伪装成已切换，也不阻塞下一次切换', async () => {
  const world = fixture('claude')
  world.core.start()
  try {
    await settle()
    const session = watch(world.core)
    await settle()
    world.peer.last().drop()
    await settle()
    await assert.rejects(
      world.command('session.configure', { ...where, settings: { effort: 'high' } }),
    )
    assert.equal(session.seen.view?.settings.effort, 'low')
    world.time.advance(500)
    await settle()
    await world.command('session.configure', { ...where, settings: { effort: 'high' } })
    assert.equal(world.saved.reasoningEffort, 'high')
  } finally {
    world.core.stop()
  }
})

test('引擎拒绝切换时恢复显示值，下一次有效切换仍可持久化', async () => {
  let reject = true
  const world = fixture('claude', async () => {
    if (reject) throw new RpcFailure(-32602, '隔离模型不支持该参数')
  })
  world.core.start()
  try {
    await settle()
    const session = watch(world.core)
    await settle()
    await assert.rejects(
      world.command('session.configure', { ...where, settings: { effort: 'high' } }),
    )
    assert.equal(session.seen.view?.settings.effort, 'low')
    assert.equal(world.saved.reasoningEffort, 'low')
    reject = false
    await world.command('session.configure', { ...where, settings: { effort: 'high' } })
    assert.equal(world.saved.reasoningEffort, 'high')
  } finally {
    world.core.stop()
  }
})

test('快速连选按顺序写入；紧接着发送等待写入，不用旧参数覆盖新值', async () => {
  let release!: () => void
  const ready = new Promise<void>((done) => {
    release = done
  })
  const world = fixture('codex', () => ready)
  world.core.start()
  try {
    await settle()
    watch(world.core)
    await settle()
    const first = world.command('session.configure', { ...where, settings: { model: 'large' } })
    const second = world.command('session.configure', {
      ...where,
      settings: { mode: 'plan', effort: 'high' },
    })
    const send = world.command('session.send', { ...where, text: '立即发送' })
    await settle()
    assert.equal(world.sent('thread/settings/update').length, 1)
    assert.equal(world.sent('turn/start').length, 0)
    release()
    await Promise.all([first, second, send])
    const params = world.sent('thread/settings/update')[1] as Record<string, any>
    assert.equal(params.collaborationMode.settings.model, 'large')
    assert.equal(world.saved.reasoningEffort, 'high')
    assert.equal((world.sent('turn/start')[0] as Record<string, unknown>).effort, undefined)
  } finally {
    release()
    world.core.stop()
  }
})

test('切换失败期间收到其他连接的有效设置，不能用失败前的旧值覆盖它', async () => {
  const world = fixture('claude', async () => {
    world.peer
      .last()
      .notify('thread/settings/updated', { threadId: 'a', threadSettings: { effort: 'medium' } })
    await settle()
    throw new RpcFailure(-32602, '隔离拒绝')
  })
  world.core.start()
  try {
    await settle()
    const session = watch(world.core)
    await settle()
    await assert.rejects(
      world.command('session.configure', { ...where, settings: { effort: 'high' } }),
    )
    assert.equal(session.seen.view?.settings.effort, 'medium')
  } finally {
    world.core.stop()
  }
})

for (const confirmed of [false, true]) {
  test(`失败回退逐字段合并通知：${confirmed ? '保留已确认的同值' : '其他字段变化不保留失败值'}`, async () => {
    const world = fixture('claude', async () => {
      world.peer.last().notify('thread/settings/updated', {
        threadId: 'a',
        threadSettings: confirmed ? { effort: 'high' } : { model: 'other-client-model' },
      })
      await settle()
      throw new RpcFailure(-32602, '隔离拒绝')
    })
    world.core.start()
    try {
      await settle()
      const session = watch(world.core)
      await settle()
      await assert.rejects(
        world.command('session.configure', {
          ...where,
          settings: { effort: 'high', permission: ':danger-full-access' },
        }),
      )
      assert.equal(session.seen.view?.settings.effort, confirmed ? 'high' : 'low')
      assert.equal(session.seen.view?.settings.permission, ':workspace')
      assert.equal(session.seen.view?.settings.model, confirmed ? 'small' : 'other-client-model')
    } finally {
      world.core.stop()
    }
  })
}

test('模式保存期间执行计划，先完成保存再退出计划模式并发送', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const world = fixture('codex', () => gate)
  world.core.start()
  try {
    await settle()
    watch(world.core)
    await settle()
    const change = world.command('session.configure', { ...where, settings: { mode: 'plan' } })
    await settle()
    const implement = world.command('session.implementPlan', { ...where, text: '执行计划' })
    await settle()
    assert.equal(world.sent('turn/start').length, 0)
    release()
    await Promise.all([change, implement])
    const sent = world.sent('turn/start')[0] as Record<string, any>
    assert.equal(sent.collaborationMode.mode, 'default')
  } finally {
    release()
    world.core.stop()
  }
})

test('其他连接切换设置：标准通知无需附带 thread，模型、强度、速度、权限和模式均立即同步', async () => {
  const world = fixture('codex')
  world.core.start()
  try {
    await settle()
    const session = watch(world.core)
    await settle()
    world.peer.last().notify('thread/settings/updated', {
      threadId: 'a',
      threadSettings: {
        model: 'large',
        effort: 'high',
        serviceTier: 'priority',
        activePermissionProfile: null,
        sandboxPolicy: { type: 'dangerFullAccess' },
        collaborationMode: { mode: 'plan' },
      },
    })
    await settle()
    assert.deepEqual(session.seen.view?.settings, {
      model: 'large',
      effort: 'high',
      speed: 'priority',
      permission: ':danger-full-access',
      mode: 'plan',
    })
    world.peer
      .last()
      .notify('thread/settings/updated', { threadId: 'a', threadSettings: { effort: 'medium' } })
    await settle()
    assert.equal(session.seen.view?.settings.effort, 'medium')
    assert.equal(session.seen.view?.settings.model, 'large', '部分通知保留未提供的设置')
  } finally {
    world.core.stop()
  }
})
