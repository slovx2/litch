import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import type { SessionOp } from '../src/channel/protocol.mjs'
import { createMockCore } from '../src/mock/mock-core.mjs'
import { createMockManagers } from '../src/mock/mock-manager.mjs'
import { sampleApp } from '../src/mock/sample-data.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import type { ItemView, SessionView } from '../src/model.mjs'
import type {
  ManagerAnswersResult,
  ManagerBoardTopicView,
  ManagerView,
} from '../src/model-manager.mjs'
import { fakeClock } from './helpers.mjs'

for (const lang of ['zh-CN', 'en'] as const)
  test(`经理原型数据完整：${lang}`, () => {
    const local = sampleManagers('local', 1_800_000_000_000, lang)
    const build = sampleManagers('build', 1_800_000_000_000, lang)
    assert.equal(
      [...local.managers, ...build.managers].filter((m) => m.status === 'active').length,
      3,
    )
    assert.equal(local.managers.filter((m) => m.status === 'ended').length, 2)
    const board = local.boards.find((b) => b.managerId === 'm1')
    assert.ok(board)
    assert.deepEqual(
      [board.decisions.length, board.items.length, board.lines.length, board.activities.length],
      [6, 9, 4, 6],
    )
    assert.equal(local.sessions.filter((s) => s.litchManager?.managerId === 'm1').length, 5)
    assert.equal(local.sessions.find((s) => s.id === 'manager-k1')?.lineage?.parentId, 'm1')
  })

test('模拟经理命令：部分提交、版本冲突、重开、结束只读、新建和更新', async () => {
  const { clock } = fakeClock()
  const devices = sampleApp('zh-CN', clock.now()).devices
  const turns: string[] = []
  const statuses: string[] = []
  const service = createMockManagers({
    clock,
    lang: 'zh-CN',
    devices: () => devices,
    device: (id) => devices.find((d) => d.id === id),
    add() {},
    mark(_device, _thread, manager) {
      statuses.push(manager.status)
    },
    ending(_device, _thread, prompt) {
      turns.push(prompt)
      return 'ending-turn'
    },
    spawn: () => 'new-manager-thread',
    say: (_device, _thread, prompt) => {
      turns.push(prompt)
    },
  })
  let board: ManagerBoardTopicView | undefined
  const close = service.subscribe(
    'local',
    {
      snapshot: (data) => {
        board = data as ManagerBoardTopicView
      },
      delta: (ops) => {
        board = (ops[0] as { view: ManagerBoardTopicView }).view
      },
      error() {},
    },
    'm1',
  )
  const command = (name: string, params: object = {}) => {
    const result = service.command(`managers.${name}`, {
      deviceId: 'local',
      managerId: 'm1',
      ...params,
    })
    assert.ok(result)
    return result
  }
  const reply = (await command('answers.submit', {
    answers: [
      { decisionId: 'D-15', revision: 1, optionId: 'a', text: '' },
      { decisionId: 'D-16', revision: 0, optionId: 'a', text: '' },
      { decisionId: 'D-17', revision: 1, optionId: null, text: '' },
    ],
  })) as ManagerAnswersResult
  assert.equal(reply.delivery, 'queued')
  assert.equal(reply.accepted.length, 1)
  assert.deepEqual(
    reply.rejected.map((r) => r.code),
    ['decisionConflict', 'invalidAnswer'],
  )
  assert.equal(turns.length, 1)
  assert.equal(parseSessionEvent(turns[0] ?? '').event?.kind, 'manager-answers')
  assert.equal(board?.board?.activities.length, 7)
  assert.equal(board?.board?.decisions.find((d) => d.id === 'D-15')?.status, 'answered')
  await command('decision.reopen', { decisionId: 'D-12' })
  assert.equal(board?.board?.decisions.find((d) => d.id === 'D-12')?.revision, 2)
  await command('update', { patch: { name: '新名字' } })
  assert.equal(turns.length, 1)
  await command('update', { patch: { scope: '只完成本轮验收', rules: '保留未完成事项' } })
  assert.equal(parseSessionEvent(turns.at(-1) ?? '').event?.kind, 'manager-rules')
  assert.match(parseSessionEvent(turns.at(-1) ?? '').event?.manager?.text ?? '', /只完成本轮验收/)
  const count = turns.length
  await command('update', { patch: { scope: '只完成本轮验收', rules: '保留未完成事项' } })
  assert.equal(turns.length, count)
  const ending = (await command('end')) as { manager: ManagerView }
  assert.equal(ending.manager.status, 'ending')
  assert.equal(ending.manager.endedAt, null)
  assert.equal(service.readOnly('local', 'm1'), true)
  assert.equal(parseSessionEvent(turns.at(-1) ?? '').event?.kind, 'manager-end')
  await assert.rejects(command('answers.submit', { answers: [] }), { code: 'rejected' })
  await assert.rejects(command('end'), { code: 'rejected' })
  await assert.rejects(command('update', { patch: { name: '不可写' } }), { code: 'rejected' })
  service.turnEnded('local', 'm1', 'other-turn')
  assert.equal(statuses.at(-1), 'ending')
  service.turnEnded('local', 'm1', 'ending-turn')
  assert.equal(statuses.at(-1), 'ended')
  assert.equal(service.readOnly('local', 'm1'), true)
  const sample = sampleManagers('local', clock.now(), 'zh-CN').managers[0]
  assert.ok(sample)
  const created = (await command('create', { manager: { ...sample, firstTask: '第一件事' } })) as {
    threadId: string
  }
  assert.equal(created.threadId, 'new-manager-thread')
  assert.equal(turns.at(-1), '第一件事')
  await assert.rejects(command('end', { deviceId: 'nas' }), {
    code: 'unsupported',
  })
  close()
})

for (const lang of ['zh-CN', 'en'] as const)
  test(`模拟经理事件在首次增量和重订阅历史中都已投影：${lang}`, async () => {
    const { clock } = fakeClock()
    const core = createMockCore({ clock, lang })
    const signal = new AbortController().signal
    const emitted: ItemView[] = []
    const watch = (sessionId: string) => {
      let snapshot: SessionView | undefined
      const close = core.subscribe(
        { kind: 'session', deviceId: 'local', sessionId },
        {
          snapshot(data) {
            snapshot = data as SessionView
          },
          delta(ops) {
            for (const op of ops as SessionOp[]) if (op.op === 'item.add') emitted.push(op.item)
          },
          error(error) {
            throw error
          },
        },
      )
      assert.ok(snapshot)
      return { snapshot, close }
    }
    const events = (items: ItemView[]) =>
      items.flatMap((item) => (item.kind === 'userMessage' && item.event ? [item.event] : []))
    const clean = (items: ItemView[]) => {
      for (const item of items)
        if (item.kind === 'userMessage') assert.doesNotMatch(item.text, /<litch-session-event/)
    }
    const initial = watch('m1')
    const where = { deviceId: 'local', managerId: 'm1' }
    await core.command(
      'managers.answers.submit',
      {
        ...where,
        answers: [
          { decisionId: 'D-15', revision: 1, optionId: 'a', text: '先核对协议' },
          { decisionId: 'D-16', revision: 1, optionId: 'a', text: '保留验收记录' },
        ],
      },
      signal,
    )
    await core.command(
      'managers.update',
      { ...where, patch: { scope: '核对事件显示', rules: '保留正文分段' } },
      signal,
    )
    await core.command('managers.end', where, signal)
    // 不只检查最终快照，防止先发原始标签再用同一 ID 补投影。
    clean(emitted)
    assert.deepEqual(
      events(emitted).map((event) => event.kind),
      ['manager-answers', 'manager-rules', 'manager-end'],
    )
    assert.equal(events(emitted)[0]?.summary, 'D-15 · D-16')
    assert.equal(events(emitted)[1]?.body, '核对事件显示\n\n保留正文分段')
    assert.equal(events(Object.values(initial.snapshot.items))[0]?.kind, 'manager-open')
    initial.close()
    const history = watch('m1')
    clean(Object.values(history.snapshot.items))
    assert.deepEqual(
      events(Object.values(history.snapshot.items)).map((event) => event.kind),
      ['manager-open', 'manager-answers', 'manager-rules', 'manager-end'],
    )
    history.close()

    const sample = sampleManagers('local', clock.now(), lang).managers[0]
    assert.ok(sample)
    for (const firstTask of ['', '   ', '先核对开场正文']) {
      const { threadId } = (await core.command(
        'managers.create',
        { deviceId: 'local', manager: { ...sample, firstTask } },
        signal,
      )) as { threadId: string }
      const created = watch(threadId)
      const items = Object.values(created.snapshot.items)
      clean(items)
      const user = items.find((item) => item.kind === 'userMessage')
      assert.ok(user?.kind === 'userMessage')
      if (firstTask.trim()) {
        assert.equal(user.text, firstTask)
        assert.equal(user.event, undefined)
      } else {
        assert.equal(user.text, '')
        assert.equal(user.event?.kind, 'manager-open')
        assert.ok(user.event.body?.includes(sample.scope))
      }
      created.close()
    }
  })

for (const interrupted of [false, true])
  test(`模拟结束回合${interrupted ? '被打断' : '完成'}后才转已结束`, async () => {
    const time = fakeClock()
    const core = createMockCore({ clock: time.clock, chunkMs: 10 })
    const signal = new AbortController().signal
    const where = { deviceId: 'local', managerId: 'm1' }
    const managers = new Map<string, ManagerView>()
    const close = core.subscribe(
      { kind: 'managers', deviceId: 'local' },
      {
        snapshot(data) {
          for (const manager of (data as { managers: ManagerView[] }).managers)
            managers.set(manager.id, manager)
        },
        delta(ops) {
          for (const op of ops as { manager: ManagerView }[])
            managers.set(op.manager.id, op.manager)
        },
        error(error) {
          throw error
        },
      },
    )
    const read = () => {
      let session: SessionView | undefined
      core.subscribe(
        { kind: 'session', deviceId: 'local', sessionId: 'm1' },
        {
          snapshot(data) {
            session = data as SessionView
          },
          delta() {},
          error(error) {
            throw error
          },
        },
      )()
      assert.ok(session)
      return session
    }
    await core.command('managers.end', where, signal)
    assert.equal(managers.get('m1')?.status, 'ending')
    assert.equal(managers.get('m1')?.endedAt, null)
    assert.equal(read().turns.at(-1)?.status, 'running')
    assert.equal(read().live, false)
    await assert.rejects(
      core.command('managers.update', { ...where, patch: { scope: '不能写' } }, signal),
      { code: 'rejected' },
    )
    if (interrupted)
      await core.command('session.interrupt', { deviceId: 'local', sessionId: 'm1' }, signal)
    else time.advance(2000)
    assert.equal(managers.get('m1')?.status, 'ended')
    const endedAt = managers.get('m1')?.endedAt
    assert.ok(endedAt !== null && endedAt !== undefined && endedAt <= time.clock.now())
    const last = read().turns.at(-1)
    assert.ok(last?.startedAt !== null && last?.startedAt !== undefined && last.durationMs !== null)
    assert.equal(endedAt, last.startedAt + last.durationMs)
    assert.equal(read().turns.at(-1)?.status, interrupted ? 'interrupted' : 'completed')
    assert.equal(read().live, false)
    close()
  })
