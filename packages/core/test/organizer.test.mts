import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyOrganizer,
  ChannelError,
  createOrganizerHost,
  emptyOrganizer,
  type OrganizerFile,
  type OrganizerLoad,
  type OrganizerOp,
  OrganizerRefusal,
  type OrganizerStore,
  type OrganizerView,
  parseOrganizer,
} from '../src/index.mjs'

const ref = (deviceId: string, sessionId: string) => ({
  kind: 'session' as const,
  deviceId,
  sessionId,
})
let n = 0
const id = () => `g${n++}`

test('文件校验：空、坏、更高版本、重复项都分得清', () => {
  assert.deepEqual(parseOrganizer(null), { kind: 'empty' })
  assert.deepEqual(parseOrganizer('x'), { kind: 'corrupt' })
  assert.deepEqual(parseOrganizer({ version: 3 }), { kind: 'newer', version: 3 })
  assert.deepEqual(parseOrganizer({ version: 0 }), { kind: 'corrupt' })
  const good = {
    version: 2,
    revision: 3,
    groups: [{ id: 'a', name: '发布', members: [ref('mac', 's1'), ref('linux', 's1')] }],
    pinOrder: [
      { kind: 'session', deviceId: 'mac', sessionId: 's2' },
      { kind: 'workspace', deviceId: 'mac', workspaceId: 'w' },
    ],
    folds: { ':pins': true, a: false },
  }
  const parsed = parseOrganizer(good)
  assert.equal(parsed.kind, 'ok')
  assert.deepEqual(parsed.kind === 'ok' ? parsed.file.folds : null, { ':pins': true })
  const dupMember = {
    ...good,
    groups: [...good.groups, { id: 'b', name: 'x', members: [ref('mac', 's1')] }],
  }
  assert.equal(parseOrganizer(dupMember).kind, 'corrupt', '一个会话最多在一个本机组里')
  assert.equal(
    parseOrganizer({ ...good, pinOrder: [good.pinOrder[0], good.pinOrder[0]] }).kind,
    'corrupt',
  )
  assert.equal(
    parseOrganizer({ ...good, groups: [{ id: 'a', name: ' 空白 ', members: [] }] }).kind,
    'corrupt',
  )
  assert.equal(
    parseOrganizer({ ...good, pinOrder: [{ kind: 'x', deviceId: 'a' }] }).kind,
    'corrupt',
  )
  assert.equal(parseOrganizer({ ...good, revision: -1 }).kind, 'corrupt')
})

test('动作：建组、加入挪组、组内排序、排组、改名、删组只删引用', () => {
  let file = emptyOrganizer()
  file = applyOrganizer(
    file,
    { type: 'group.create', name: ' 发布 ', members: [ref('mac', 'a')] },
    id,
  )
  file = applyOrganizer(file, { type: 'group.create', name: '回归' }, id)
  const [one, two] = file.groups
  assert.ok(one && two)
  assert.equal(one.name, '发布')
  assert.equal(file.revision, 2)
  // 跨设备混装；已在别的组里的挪过来
  file = applyOrganizer(
    file,
    { type: 'member.add', groupId: two.id, member: ref('linux', 'b') },
    id,
  )
  file = applyOrganizer(
    file,
    { type: 'member.add', groupId: two.id, member: ref('mac', 'a'), to: 0 },
    id,
  )
  assert.deepEqual(file.groups[0]?.members, [])
  assert.deepEqual(file.groups[1]?.members, [ref('mac', 'a'), ref('linux', 'b')])
  file = applyOrganizer(file, { type: 'member.move', member: ref('mac', 'a'), to: 1 }, id)
  assert.deepEqual(file.groups[1]?.members, [ref('linux', 'b'), ref('mac', 'a')])
  file = applyOrganizer(file, { type: 'group.move', groupId: two.id, to: 0 }, id)
  assert.deepEqual(
    file.groups.map((group) => group.id),
    [two.id, one.id],
  )
  const same = applyOrganizer(file, { type: 'group.move', groupId: two.id, to: 0 }, id)
  assert.equal(same, file, '没变不加版本号')
  file = applyOrganizer(file, { type: 'fold', key: two.id, closed: true }, id)
  file = applyOrganizer(file, { type: 'group.delete', groupId: two.id }, id)
  assert.deepEqual(
    file.groups.map((group) => group.id),
    [one.id],
  )
  assert.deepEqual(file.folds, {}, '删组连收起记录一起清')
  file = applyOrganizer(file, { type: 'group.rename', groupId: one.id, name: '准备' }, id)
  assert.equal(file.groups[0]?.name, '准备')
  assert.throws(
    () => applyOrganizer(file, { type: 'group.rename', groupId: one.id, name: '  ' }, id),
    (error: unknown) => error instanceof OrganizerRefusal && error.reason === 'invalid',
  )
  assert.throws(
    () => applyOrganizer(file, { type: 'group.delete', groupId: 'nope' }, id),
    (error: unknown) => error instanceof OrganizerRefusal && error.reason === 'notFound',
  )
})

test('置顶先后：版本号对不上就拒绝，免得两个窗口互相覆盖', () => {
  const pin = { kind: 'session', deviceId: 'mac', sessionId: 'a' } as const
  let file = emptyOrganizer()
  file = applyOrganizer(file, { type: 'pins.order', order: [pin], base: 0 }, id)
  assert.equal(file.revision, 1)
  assert.throws(
    () => applyOrganizer(file, { type: 'pins.order', order: [], base: 0 }, id),
    (error: unknown) => error instanceof OrganizerRefusal && error.reason === 'conflict',
  )
  file = applyOrganizer(file, { type: 'pins.drop', ref: pin }, id)
  assert.deepEqual(file.pinOrder, [])
})

function fakeStore(initial: OrganizerLoad) {
  let current = initial
  let fail = false
  const writes: OrganizerFile[] = []
  const store: OrganizerStore = {
    load: () => current,
    save(file) {
      if (fail) throw new Error('磁盘已满')
      writes.push(file)
      current = { kind: 'ok', file }
    },
  }
  return {
    store,
    writes,
    failNext(value: boolean) {
      fail = value
    },
  }
}

test('核心里的一份：存盘成功才推给所有窗口，失败保留上一份并报原因', () => {
  const disk = fakeStore({ kind: 'empty' })
  const host = createOrganizerHost(disk.store, () => 1000)
  const seen: OrganizerView[][] = [[], []]
  for (const list of seen) {
    host.subscribe({
      snapshot: (view) => list.push(view as OrganizerView),
      delta: (ops) => list.push(...(ops as OrganizerOp[]).map((op) => op.view)),
      error() {},
    })
  }
  const made = host.apply({ type: 'group.create', name: '发布' })
  assert.ok(made.groupId)
  assert.equal(disk.writes.length, 1)
  assert.equal(seen[0]?.at(-1)?.groups[0]?.id, made.groupId)
  assert.equal(seen[1]?.at(-1)?.groups[0]?.id, made.groupId, '每个窗口都收到同一份')
  disk.failNext(true)
  assert.throws(
    () => host.apply({ type: 'group.create', name: '回归' }),
    (error: unknown) => error instanceof ChannelError && error.text?.key === 'fault.organizerSave',
  )
  assert.equal(host.view().groups.length, 1, '没存上就不算数')
  assert.equal(seen[0]?.length, 2)
})

test('文件坏了、版本更高：停用写入，原文件不被空的覆盖', () => {
  for (const loaded of [{ kind: 'corrupt' }, { kind: 'newer', version: 9 }] as const) {
    const disk = fakeStore(loaded)
    const host = createOrganizerHost(disk.store, () => 1)
    assert.equal(host.view().status, loaded.kind)
    assert.throws(() => host.apply({ type: 'group.create', name: 'x' }), ChannelError)
    assert.equal(disk.writes.length, 0)
  }
})
