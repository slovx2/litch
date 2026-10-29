import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  type Manager,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { ManagerBoardWriter } from '../src/manager-board.mjs'
import { MANAGER_SCHEMA_VERSION, ManagerStore, openManagerDatabase } from '../src/manager-store.mjs'

const manager = (id: string): Manager => ({
  id,
  threadId: `${id}-thread`,
  name: '',
  scope: 'test',
  cwd: '/tmp',
  harness: 'pi',
  model: null,
  effort: null,
  template: 'blank',
  dispatch: { ...MANAGER_DEFAULT_DISPATCH },
  contact: { ...MANAGER_DEFAULT_CONTACT },
  rules: '',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  endedAt: null,
  pendingDecisions: 0,
  runningLines: 0,
  latestActivity: null,
})

test('经理库：迁移、重开、计数隔离和事务回滚，不删审计记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-store-'))
  let store = new ManagerStore(openManagerDatabase(dir))
  try {
    assert.equal(
      store.db.prepare('PRAGMA user_version').get()?.user_version,
      MANAGER_SCHEMA_VERSION,
    )
    store.saveManager(manager('a'))
    store.saveManager(manager('b'))
    const writer = new ManagerBoardWriter(store, () => false)
    const first = writer.tool('a', 'add', {
      kind: 'decision',
      decision: { title: '选择？', background: '背景' },
    }) as any
    assert.equal(first.id, 'D-1')
    assert.equal(
      (
        writer.tool('b', 'add', {
          kind: 'decision',
          decision: { title: '另一个', background: '' },
        }) as any
      ).id,
      'D-1',
    )
    const count = store.changes('a').length
    assert.throws(() =>
      writer.tool('a', 'add', {
        kind: 'decision',
        decision: { title: '无效', background: '', recommend: 'missing' },
      }),
    )
    assert.equal(store.changes('a').length, count)
    assert.equal(
      (
        writer.tool('a', 'add', {
          kind: 'decision',
          decision: { title: '继续', background: '' },
        }) as any
      ).id,
      'D-2',
    )
    writer.tool('a', 'close', {
      kind: 'decision',
      id: 'D-1',
      status: 'withdrawn',
      reason: '范围变化',
    })
    writer.reopen('a', 'D-1')
    assert.equal(store.object('a', 'D-1')?.revision, 3)
    const history = store.changes('a')
    assert.equal(history[0]?.before?.status, 'withdrawn')
    store.close()
    store = new ManagerStore(openManagerDatabase(dir))
    assert.deepEqual(store.changes('a'), history)
    assert.equal(store.object('a', 'D-1')?.revision, 3)
    assert.equal(
      (
        new ManagerBoardWriter(store, () => false).tool('a', 'add', {
          kind: 'item',
          item: { title: '事项' },
        }) as any
      ).id,
      'I-1',
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('经理库：未来版本拒绝打开且不改版本和已有内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-future-'))
  const store = new ManagerStore(openManagerDatabase(dir))
  store.saveManager(manager('a'))
  store.db.exec('PRAGMA user_version=999')
  store.close()
  try {
    assert.throws(() => openManagerDatabase(dir), /拒绝打开/)
    const db = new DatabaseSync(join(dir, 'manager.sqlite'), { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 999)
    assert.equal(db.prepare('SELECT count(*) AS count FROM managers').get()?.count, 1)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('经理工具：字段和引用校验、修订号、核对、关闭、口头答复与只读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-write-'))
  const store = new ManagerStore(openManagerDatabase(dir))
  try {
    store.saveManager(manager('a'))
    const writer = new ManagerBoardWriter(store, (_, id) => id === 'line')
    const call = (tool: string, args: unknown) => writer.tool('a', tool, args) as any
    call('add', {
      kind: 'item',
      item: { title: '事项', owner: { kind: 'line', threadId: 'line' } },
    })
    call('add', {
      kind: 'decision',
      decision: {
        title: '选择',
        background: '',
        blocks: ['I-1'],
        options: [{ id: 'yes', label: '同意', description: '' }],
        recommend: 'yes',
      },
    })
    assert.throws(() =>
      call('add', {
        kind: 'item',
        item: { title: '错误归属', owner: { kind: 'line', threadId: 'other' } },
      }),
    )
    assert.throws(() =>
      call('update', { kind: 'item', id: 'I-1', patch: { status: 'blocked' }, why: '阻塞' }),
    )
    assert.throws(() =>
      call('update', { kind: 'decision', id: 'D-1', patch: { id: 'D-9' }, why: '伪造' }),
    )
    call('update', {
      kind: 'item',
      id: 'I-1',
      patch: { status: 'blocked', why: '等答复', blockedBy: ['D-1'] },
      why: '等答复',
    })
    assert.equal(
      call('verify', { id: 'I-1', commit: 'abc', why: '读过代码' }).object.checked.commit,
      'abc',
    )
    call('close', { kind: 'item', id: 'I-1', status: 'done', reason: '通过验收' })
    const answered = call('answer', { id: 'D-1', optionId: 'yes', text: '照办' }).object
    assert.equal(answered.answer.by, 'user-conversation')
    assert.throws(() =>
      call('close', { kind: 'decision', id: 'D-1', status: 'expired', reason: '结束' }),
    )
    assert.throws(() => writer.reopen('a', 'D-1'))
    call('status', { text: '已完成' })
    assert.equal(store.situation('a')?.text, '已完成')
    store.saveManager({ ...manager('a'), status: 'ended' })
    assert.equal(call('get', { id: 'D-1' }).object.status, 'answered')
    for (const [tool, args] of [
      ['status', { text: '覆盖' }],
      ['verify', { id: 'D-1', commit: null, why: '改' }],
    ] as const)
      assert.throws(() => call(tool, args), /read-only/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('答复：部分成功、重复条目全拒、revision 冲突、事务内持久事件和重试去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-answers-'))
  const store = new ManagerStore(openManagerDatabase(dir))
  try {
    store.saveManager(manager('a'))
    const writer = new ManagerBoardWriter(store, () => false)
    for (let i = 0; i < 4; i++)
      writer.tool('a', 'add', {
        kind: 'decision',
        decision: { title: `决策 ${i}`, background: '' },
      })
    writer.tool('a', 'update', {
      kind: 'decision',
      id: 'D-2',
      patch: { background: '变了' },
      why: '新证据',
    })
    const answer = (id: number) => ({
      decisionId: `D-${id}`,
      revision: 1,
      optionId: null,
      text: '答复',
    })
    const result = writer.answers('a', [answer(1), answer(2), answer(3), answer(3), answer(9)])
    assert.deepEqual(
      result.accepted.map((one) => one.id),
      ['D-1'],
    )
    assert.deepEqual(
      result.rejected.map((one) => one.code),
      ['decisionConflict', 'invalidAnswer', 'invalidAnswer', 'unknownDecision'],
    )
    assert.equal(result.delivery, 'queued')
    assert.equal(store.deliveries().length, 1)
    const event = parseSessionEvent(store.deliveries()[0]?.text ?? '').event
    assert.equal(event?.kind, 'manager-answers')
    assert.deepEqual(
      event?.manager?.answers?.map((one) => one.decisionId),
      ['D-1'],
    )
    assert.equal(writer.answers('a', [answer(1)]).delivery, 'none')
    assert.equal(store.deliveries().length, 1)
    const enqueue = store.enqueue.bind(store)
    store.enqueue = () => {
      throw new Error('写入失败')
    }
    assert.throws(() => writer.answers('a', [answer(4)]), /写入失败/)
    assert.equal(store.object('a', 'D-4')?.status, 'open')
    store.enqueue = enqueue
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('经理库从版本 1 升级：保留看板、历史、编号和待投递事件，增加收尾绑定表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-upgrade-'))
  let store = new ManagerStore(openManagerDatabase(dir))
  try {
    store.saveManager(manager('a'))
    const writer = new ManagerBoardWriter(store, () => false)
    writer.tool('a', 'add', {
      kind: 'decision',
      decision: { title: '迁移前的问题', background: '' },
    })
    writer.answers('a', [{ decisionId: 'D-1', revision: 1, optionId: null, text: '保留' }])
    const changes = store.changes('a')
    const events = store.deliveries('a')
    store.db.exec('DROP TABLE endings; PRAGMA user_version=1')
    store.close()
    store = new ManagerStore(openManagerDatabase(dir))
    assert.deepEqual(store.changes('a'), changes)
    assert.deepEqual(store.deliveries('a'), events)
    assert.equal(store.object('a', 'D-1')?.status, 'answered')
    assert.equal(store.nextId('a', 'D'), 'D-2')
    store.beginEnding('a', 'end-event', '收尾')
    store.setEndingTurn('a', 'end-turn')
    assert.deepEqual(store.ending('a'), { eventId: 'end-event', text: '收尾', turnId: 'end-turn' })
    assert.equal(
      store.db.prepare('PRAGMA user_version').get()?.user_version,
      MANAGER_SCHEMA_VERSION,
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
