import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMockManagers } from '../src/mock/mock-manager.mjs'
import { sampleApp } from '../src/mock/sample-data.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import type { ManagerAnswersResult, ManagerBoardTopicView } from '../src/model-manager.mjs'
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
    const board = local.boards.find((b) => b.managerId === 'm1')!
    assert.deepEqual(
      [board.decisions.length, board.items.length, board.lines.length, board.activities.length],
      [6, 9, 4, 6],
    )
    assert.equal(local.sessions.filter((s) => s.litchManager?.managerId === 'm1').length, 5)
    assert.equal(local.sessions.find((s) => s.id === 'k1')?.lineage?.parentId, 'm1')
  })

test('模拟经理命令：部分提交、版本冲突、重开、结束只读、新建和更新', async () => {
  const { clock } = fakeClock()
  const devices = sampleApp('zh-CN', clock.now()).devices
  const turns: string[] = []
  const service = createMockManagers({
    clock,
    lang: 'zh-CN',
    devices: () => devices,
    device: (id) => devices.find((d) => d.id === id),
    add() {},
    mark() {},
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
  const command = (name: string, params: object = {}) =>
    service.command(`managers.${name}`, { deviceId: 'local', managerId: 'm1', ...params })!
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
  assert.equal(board?.board?.activities.length, 7)
  assert.equal(board?.board?.decisions.find((d) => d.id === 'D-15')?.status, 'answered')
  await command('decision.reopen', { decisionId: 'D-12' })
  assert.equal(board?.board?.decisions.find((d) => d.id === 'D-12')?.revision, 2)
  await command('update', { patch: { name: '新名字' } })
  await command('end')
  await assert.rejects(command('update', { patch: { name: '不可写' } }), { code: 'rejected' })
  const sample = sampleManagers('local', clock.now(), 'zh-CN').managers[0]!
  const created = (await command('create', { manager: { ...sample, firstTask: '第一件事' } })) as {
    threadId: string
  }
  assert.equal(created.threadId, 'new-manager-thread')
  assert.equal(turns.at(-1), '第一件事')
  await assert.rejects(service.command('managers.end', { deviceId: 'nas', managerId: 'm1' })!, {
    code: 'unsupported',
  })
  close()
})
