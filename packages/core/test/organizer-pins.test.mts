import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceView,
  keys,
  memberState,
  mergePins,
  movePin,
  type OrganizerView,
  type PinRef,
  pinCover,
  pinSourceOf,
  projectSidebarGroups,
  type SessionSummary,
  serveChannel,
  type WorkspaceView,
} from '../src/index.mjs'
import { sampleSidebars } from '../src/mock/sample-data.mjs'
import { fakeClock, settle } from './helpers.mjs'

const s = (deviceId: string, sessionId: string): PinRef => ({
  kind: 'session',
  deviceId,
  sessionId,
})
const w = (deviceId: string, workspaceId: string): PinRef => ({
  kind: 'workspace',
  deviceId,
  workspaceId,
})
const source = (
  deviceId: string,
  sessions: string[],
  workspaces: string[] = [],
  loaded = true,
) => ({
  deviceId,
  loaded,
  sessions,
  workspaces,
})

test('置顶合并：首次按设备登记顺序和设备内次序，之后照本机记着的排，新的接在最后', () => {
  const sources = [source('mac', ['a', 'b'], ['w1']), source('linux', ['c'])]
  const first = mergePins([], sources)
  assert.deepEqual(first.shown, [s('mac', 'a'), s('mac', 'b'), w('mac', 'w1'), s('linux', 'c')])
  // 本机手排过，允许跨设备交错；新置顶的 d 追加在最后
  const saved = [s('linux', 'c'), s('mac', 'b'), s('mac', 'a'), w('mac', 'w1')]
  const later = mergePins(saved, [source('mac', ['a', 'b', 'd'], ['w1']), source('linux', ['c'])])
  assert.deepEqual(later.shown, [...saved, s('mac', 'd')])
})

test('置顶合并：目录没到的设备留着位置不显示，取消置顶的清掉，删掉连接的丢掉', () => {
  const saved = [s('linux', 'c'), s('mac', 'a'), s('gone', 'x'), s('mac', 'b')]
  const merged = mergePins(saved, [source('mac', ['a']), source('linux', [], [], false)])
  assert.deepEqual(merged.shown, [s('mac', 'a')], 'b 取消了置顶，linux 还没加载')
  assert.deepEqual(merged.stored, [s('linux', 'c'), s('mac', 'a')])
})

test('置顶挪位置：只排看得见的，没加载的设备占着原来的格子', () => {
  const merged = mergePins(
    [s('mac', 'a'), s('linux', 'c'), s('mac', 'b')],
    [source('mac', ['a', 'b']), source('linux', ['c'], [], false)],
  )
  assert.deepEqual(merged.shown, [s('mac', 'a'), s('mac', 'b')])
  assert.deepEqual(movePin(merged, s('mac', 'b'), 0), [
    s('mac', 'b'),
    s('linux', 'c'),
    s('mac', 'a'),
  ])
  assert.equal(movePin(merged, s('mac', 'a'), 0), null, '没动')
})

const example = sampleSidebars(10_000, 'zh-CN')[0]?.sessions[0]
assert.ok(example)
const summary = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  ...example,
  id,
  unread: false,
  pinned: false,
  section: null,
  workspaceId: null,
  lineage: null,
  nativeLineage: null,
  updatedAt: 10,
  ...patch,
})
const workspace = (id: string, pinned: boolean): WorkspaceView => ({
  id,
  name: id,
  roots: [`/${id}`],
  color: null,
  pinned,
  sectionId: null,
})

test('置顶覆盖：置顶会话、置顶项目里的会话和它们的子会话；投影里不再出现', () => {
  const groups = { ':pinned': ['p'], w1: ['in'], w2: ['plain'], '': ['kid'] }
  const children = { p: ['kid'] }
  const cover = pinCover(groups, [workspace('w1', true), workspace('w2', false)], children)
  assert.deepEqual(cover, ['in', 'kid', 'p'])
  const sessions = new Map(
    [
      summary('p', { pinned: true, unread: true }),
      summary('kid', { lineage: { parentId: 'p' } as SessionSummary['lineage'], unread: true }),
      summary('in', { workspaceId: 'w1', unread: true }),
      summary('plain', { workspaceId: 'w2', unread: true }),
    ].map((row) => [row.id, row]),
  )
  const projected = projectSidebarGroups('mac', sessions, () => 5, new Set(cover))
  assert.deepEqual(
    projected.unread.map((row) => row.sessionId),
    ['plain'],
  )
  assert.deepEqual(
    projected.recent.map((row) => row.sessionId),
    ['plain'],
  )
  assert.deepEqual(
    pinSourceOf('mac', groups, [workspace('w1', true)]),
    source('mac', ['p'], ['w1']),
  )
  assert.equal(pinSourceOf('mac', undefined, undefined).loaded, false)
})

test('本机组成员的情况：置顶、未配置、未加载、归档、删除分得清', () => {
  const online = { connection: 'online', stale: false, note: null } as unknown as DeviceView
  const offline = { connection: 'offline', stale: true, note: null } as unknown as DeviceView
  const ref = { deviceId: 'mac', sessionId: 'a' }
  const base = { device: online, listed: true, covered: false, archived: null }
  assert.equal(memberState(ref, base), 'ok')
  assert.equal(memberState(ref, { ...base, covered: true }), 'pinned')
  assert.equal(memberState(ref, { ...base, device: undefined }), 'unconfigured')
  assert.equal(memberState(ref, { ...base, listed: false, device: offline }), 'unloaded')
  assert.equal(memberState(ref, { ...base, listed: false, archived: ['a'] }), 'archived')
  assert.equal(memberState(ref, { ...base, listed: false, archived: [] }), 'deleted')
  assert.equal(memberState(ref, { ...base, listed: false }), 'missing')
})

test('副本：本机整理经通道推给每个窗口；只改本机，不发设备整理命令', async () => {
  const { clock, advance } = fakeClock()
  const core = createMockCore({ clock, chunkMs: 0 })
  const names: string[] = []
  const windows = [0, 1].map(() => {
    const [ui, side] = createPortPair()
    serveChannel(
      side,
      {
        ...core,
        command(name, params, signal) {
          names.push(name)
          return core.command(name, params, signal)
        },
      },
      { clock },
    )
    const channel = connectChannel(ui)
    const replica = createReplica(channel)
    replica.start()
    return { channel, replica }
  })
  await settle()
  const [one, two] = windows
  assert.ok(one && two)
  assert.equal(one.replica.store.get<OrganizerView>(keys.organizer)?.status, 'ok')
  const made = await one.channel.command('organizer.apply', {
    action: {
      type: 'group.create',
      name: '跨设备',
      members: [{ deviceId: 'local', sessionId: 'x' }],
    },
  })
  advance(50)
  await settle()
  const view = two.replica.store.get<OrganizerView>(keys.organizer)
  assert.equal(view?.groups[0]?.id, made.groupId)
  assert.deepEqual(view?.groups[0]?.members, [{ deviceId: 'local', sessionId: 'x' }])
  assert.deepEqual(
    names.filter((name) => name !== 'core.info'),
    ['organizer.apply'],
  )
})
