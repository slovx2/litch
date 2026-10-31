import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settle } from './helpers.mjs'
import { finished, setup, started, watch, where } from './world.mjs'

const patch = { model: 'konstants/opus', effort: 'high' }
const item = { type: 'contextCompaction', id: 'compact:1' } as const

async function prepare(delayed = false) {
  let accept!: () => void
  const world = setup(undefined, {
    'thread/compact/start': () =>
      delayed
        ? new Promise<Record<string, never>>((resolve) => {
            accept = () => resolve({})
          })
        : {},
  })
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  const previous = session.seen.view?.settings.model
  const done = world.command('session.compact', { ...where, thenConfigure: patch })
  // 错误可能在后面才断言，先接住以免测试误报未处理拒绝。
  void done.catch(() => {})
  await settle()
  const server = world.peer.last()
  const start = () => {
    server.notify('turn/started', { threadId: 'a', turn: started('c1') })
    server.notify('item/started', { threadId: 'a', turnId: 'c1', item, startedAtMs: 0 })
  }
  const finish = (
    status: 'completed' | 'interrupted' | 'failed' = 'completed',
    withItem = true,
  ) => {
    if (withItem)
      server.notify('item/completed', { threadId: 'a', turnId: 'c1', item, completedAtMs: 0 })
    server.notify('turn/completed', { threadId: 'a', turn: finished('c1', { status }) })
  }
  return { ...world, session, previous, done, start, finish, accept: () => accept() }
}

for (const delayed of [false, true])
  test(`压缩成功后再换型号和强度；${delayed ? '通知先到' : '应答先到'}`, async () => {
    const world = await prepare(delayed)
    const { command, session, previous, done, start, finish, sent, core } = world
    try {
      assert.equal(session.seen.view?.settings.model, previous)
      await assert.rejects(command('session.compact', where), { code: 'rejected' })
      await assert.rejects(
        command('session.configure', { ...where, settings: { model: 'other' } }),
        { code: 'rejected' },
      )
      start()
      await settle()
      await command('session.send', { ...where, text: '下一条', images: [], extras: [] })
      finish()
      await settle()
      if (delayed) {
        assert.equal(sent('turn/start').length, 0)
        assert.equal(session.seen.view?.settings.model, previous)
        world.accept()
      }
      await done
      await settle()
      assert.equal(session.seen.view?.settings.model, patch.model)
      assert.equal(session.seen.view?.settings.effort, patch.effort)
      assert.equal((sent('turn/start')[0] as { model: string }).model, patch.model)
    } finally {
      core.stop()
    }
  })

for (const status of ['interrupted', 'failed', 'completed'] as const)
  test(`压缩${status}但没有完成条目时不切换`, async () => {
    const { core, session, previous, done, start, finish } = await prepare()
    try {
      start()
      finish(status, false)
      await assert.rejects(done, { code: 'rejected' })
      assert.equal(session.seen.view?.settings.model, previous)
    } finally {
      core.stop()
    }
  })

test('等待超时不切换，迟到的成功也不切换', async () => {
  const { core, time, session, previous, done, start, finish } = await prepare()
  try {
    start()
    await settle()
    time.advance(10 * 60_000)
    await assert.rejects(done, { code: 'rejected' })
    finish()
    await settle()
    assert.equal(session.seen.view?.settings.model, previous)
  } finally {
    core.stop()
  }
})

test('压缩期间断线立即结束等待，不切换', async () => {
  const { core, peer, session, previous, done, start } = await prepare()
  try {
    start()
    await settle()
    peer.last().drop()
    await assert.rejects(done, { code: 'offline' })
    assert.equal(session.seen.view?.settings.model, previous)
  } finally {
    core.stop()
  }
})

test('普通回合进行中拒绝压缩后切换；直接配置不压缩', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  try {
    peer.last().notify('turn/started', { threadId: 'a', turn: started('work') })
    await settle()
    await assert.rejects(command('session.compact', { ...where, thenConfigure: patch }), {
      code: 'rejected',
    })
    assert.equal(sent('thread/compact/start').length, 0)
    peer.last().notify('turn/completed', { threadId: 'a', turn: finished('work') })
    await command('session.configure', { ...where, settings: patch })
    assert.equal(session.seen.view?.settings.model, patch.model)
    assert.equal(sent('thread/compact/start').length, 0)
  } finally {
    core.stop()
  }
})
