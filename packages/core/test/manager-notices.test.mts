import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MANAGER_METHOD,
  MANAGER_NOTIFICATION,
  type ManagerDecision,
} from '../../protocol/src/manager.mjs'
import { ChannelError, type ManagersOp } from '../src/channel/protocol.mjs'
import { createManagers, type ManagersHost } from '../src/device/manager.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { settle } from './helpers.mjs'

function world(enabled = true) {
  const data = sampleManagers('local', 1_800_000_000, 'zh-CN')
  const manager = structuredClone(data.managers[0])
  const board = structuredClone(data.boards[0])
  assert.ok(manager && board)
  manager.contact.desktopNotification = enabled
  const notices: Extract<ManagersOp, { op: 'manager.decisionOpened' }>[] = []
  let online = true
  let delay: (() => Promise<{ board: typeof board }>) | null = null
  let reads = 0
  const service = createManagers({
    deviceId: 'local',
    online: () => online,
    supported: () => true,
    request: (async (method: string) => {
      if (method === MANAGER_METHOD.list) return { managers: [structuredClone(manager)] }
      assert.equal(method, MANAGER_METHOD.boardRead)
      reads++
      return delay ? delay() : { board: structuredClone(board) }
    }) as ManagersHost['request'],
    changed() {},
    log() {},
    fail: (error) => new ChannelError('internal', String(error)),
  })
  const open = () =>
    service.open({
      snapshot() {},
      delta(ops) {
        for (const op of ops as ManagersOp[])
          if (op.op === 'manager.decisionOpened') notices.push(op)
      },
      error() {},
    })
  const stop = open()
  service.resync()
  return {
    manager,
    notices,
    service,
    stop,
    open,
    get board() {
      return board
    },
    get reads() {
      return reads
    },
    setDelay(next: typeof delay) {
      delay = next
    },
    add(id: ManagerDecision['id'] = 'D-99') {
      const template = board.decisions[0]
      assert.ok(template)
      const decision: ManagerDecision = { ...structuredClone(template), id, status: 'open' }
      board.decisions.push(decision)
      return decision
    },
    changed() {
      service.notification(MANAGER_NOTIFICATION.boardChanged, { managerId: manager.id })
    },
    toggle(enabled: boolean) {
      manager.contact.desktopNotification = enabled
      manager.updatedAt++
      service.notification(MANAGER_NOTIFICATION.changed, { manager: structuredClone(manager) })
    },
    offline() {
      online = false
      service.offline()
    },
    reconnect() {
      online = true
      service.resync()
    },
  }
}

test('未打开看板也通知新决策；首次加载、重复失效、文字修改和重新加载不补发', async () => {
  const w = world()
  await settle()
  assert.ok(w.reads > 0)
  assert.equal(w.notices.length, 0)
  const decision = w.add()
  w.changed()
  await settle()
  assert.deepEqual(
    w.notices.map((op) => op.decision.id),
    ['D-99'],
  )
  decision.title = '修改标题'
  decision.revision++
  w.changed()
  w.changed()
  await settle()
  const close = w.service.openBoard(w.manager.id, { snapshot() {}, delta() {}, error() {} })
  await settle()
  close()
  assert.equal(w.notices.length, 1)
  w.stop()
  w.add('D-100')
  w.open()
  await settle()
  assert.equal(w.notices.length, 1, '重新建立列表订阅只建立基线')
})

test('关闭开关不读取后台看板、不通知；重新开启不补发', async () => {
  const w = world()
  await settle()
  w.toggle(false)
  const reads = w.reads
  w.add()
  w.changed()
  await settle()
  assert.equal(w.reads, reads)
  assert.equal(w.notices.length, 0)
  w.toggle(true)
  await settle()
  assert.equal(w.notices.length, 0)
  w.add('D-100')
  w.changed()
  await settle()
  assert.deepEqual(
    w.notices.map((op) => op.decision.id),
    ['D-100'],
  )
})

test('开关初始关闭，即使用户正在订阅看板也不通知', async () => {
  const w = world(false)
  await settle()
  assert.equal(w.reads, 0)
  const close = w.service.openBoard(w.manager.id, { snapshot() {}, delta() {}, error() {} })
  await settle()
  w.add()
  w.changed()
  await settle()
  assert.equal(w.notices.length, 0)
  w.toggle(true)
  await settle()
  assert.equal(w.notices.length, 0)
  close()
  w.add('D-100')
  w.changed()
  await settle()
  assert.equal(w.notices.length, 1)
})

test('断线废弃在途结果；重连不补发断线期间新增或重新打开的决策', async () => {
  const w = world()
  await settle()
  let resolve: (value: { board: typeof w.board }) => void = () => {}
  w.setDelay(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  w.add()
  w.changed()
  const stale = structuredClone(w.board)
  w.offline()
  resolve({ board: stale })
  await settle()
  w.setDelay(null)
  w.add('D-100')
  w.reconnect()
  await settle()
  assert.equal(w.notices.length, 0)
  w.add('D-101')
  w.changed()
  await settle()
  assert.deepEqual(
    w.notices.map((op) => op.decision.id),
    ['D-101'],
  )
})

test('已关闭后重新待答通知一次；两次读取间关闭又重开也按变更记录识别', async () => {
  const w = world()
  await settle()
  const decision = w.board.decisions[0]
  assert.ok(decision)
  decision.status = 'withdrawn'
  decision.revision++
  w.changed()
  await settle()
  decision.status = 'open'
  decision.revision++
  w.changed()
  await settle()
  assert.equal(w.notices.length, 1)
  decision.revision += 2
  w.board.changes.push({
    id: 'reopen-2',
    objectId: decision.id,
    by: 'user',
    at: 1_800_000_001,
    fields: ['status', 'revision'],
    before: { status: 'withdrawn' },
    after: { status: 'open', revision: decision.revision },
    why: '重新打开',
  })
  w.changed()
  await settle()
  assert.equal(w.notices.length, 2)
  w.changed()
  await settle()
  assert.equal(w.notices.length, 2)
})

test('读取中失效只对最终看板通知，已知过时结果不通知', async () => {
  const w = world()
  await settle()
  let resolve: (value: { board: typeof w.board }) => void = () => {}
  w.setDelay(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const decision = w.add()
  w.changed()
  const stale = structuredClone(w.board)
  decision.status = 'answered'
  decision.revision++
  w.changed()
  w.setDelay(null)
  resolve({ board: stale })
  await settle()
  assert.equal(w.notices.length, 0)
})
