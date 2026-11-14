import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CoreHost, DeviceView, HostSink, SessionSummary, SidebarView } from '@litch/core'
import { reportRemotePower } from '../remote-power.mjs'
import { RemotePowerActivity, watchRemotePower } from '../remote-power-activity.mjs'

const device = (id = 'remote', connection: DeviceView['connection'] = 'online') =>
  ({
    id,
    kind: id === 'local' ? 'local' : 'ssh',
    connection,
    stale: false,
    note: null,
    harnesses: [
      { id: 'codex', state: 'ready' },
      { id: 'claude-code', state: 'ready' },
    ],
  }) as DeviceView
const row = (id = 'a', status: SessionSummary['status'] = 'running', background = 0) =>
  ({
    id,
    harness: 'codex',
    status,
    background: { running: background },
  }) as SessionSummary
const sidebar = (...sessions: SessionSummary[]) => ({ sessions, archived: null }) as SidebarView
const work = (activity: RemotePowerActivity) =>
  activity.snapshot().sources.reduce((sum, source) => sum + source.working, 0)

test('只统计远程，跨设备与 harness 聚合回合、等待及后台；不看界面是否展开', () => {
  const activity = new RemotePowerActivity(() => 0)
  activity.device(device('local'))
  activity.sidebar('local', sidebar(row()))
  assert.equal(work(activity), 0)
  activity.device(device())
  activity.sidebar(
    'remote',
    sidebar(row(), row('b', 'waiting'), row('c', 'idle', 2), row('d', 'idle')),
  )
  activity.device(device('remote-2'))
  activity.sidebar('remote-2', sidebar({ ...row('a'), harness: 'claude-code' }))
  assert.equal(work(activity), 4)
  activity.delta('remote', [{ op: 'session.upsert', session: row('a', 'idle') }])
  activity.remove('remote-2')
  assert.equal(work(activity), 2)
})

test('断线未知保留原始时间，心跳与其他设备的进展不能续期；重连须等首屏对账', () => {
  let now = 0
  const activity = new RemotePowerActivity(() => now)
  activity.device(device())
  activity.sidebar('remote', sidebar(row()))
  activity.snapshot()
  now = 20_000
  activity.device(device('remote', 'reconnecting'))
  assert.equal(activity.snapshot().sources[0]?.observedAgoMs, 20_000)
  now = 85_000
  activity.device(device('another'))
  activity.sidebar('another', sidebar(row()))
  let stale = activity.snapshot().sources.find((source) => source.unknown)
  assert.equal(stale?.observedAgoMs, 85_000)
  activity.device(device())
  now = 95_000
  stale = activity.snapshot().sources.find((source) => source.unknown)
  assert.equal(stale?.observedAgoMs, 95_000)
  activity.sidebar('remote', sidebar(row('a', 'idle')))
  assert.equal(activity.snapshot().sources.length, 1)
})

test('单个 harness 不可用只冻结它的证据；缓存快照不把未知重新变新鲜', () => {
  let now = 0
  const activity = new RemotePowerActivity(() => now)
  activity.device(device())
  activity.sidebar('remote', sidebar(row()))
  activity.snapshot()
  const down = device()
  down.harnesses = down.harnesses.map((harness) => ({ ...harness, state: 'unavailable' }))
  now = 90_000
  activity.device(down)
  activity.sidebar('remote', sidebar(row()))
  const report = activity.snapshot()
  assert.equal(report.sources[0]?.unknown, true)
  assert.equal(report.sources[0]?.observedAgoMs, 90_000)
})

test('归档表替换和删除不会留下活动副本', () => {
  const activity = new RemotePowerActivity(() => 0)
  activity.device(device())
  activity.sidebar('remote', { ...sidebar(), archived: [row()] })
  assert.equal(work(activity), 1)
  activity.delta('remote', [{ op: 'archived.set', sessions: [] }])
  assert.equal(work(activity), 0)
  activity.delta('remote', [{ op: 'session.upsert', session: row() }])
  assert.equal(work(activity), 1)
  activity.delta('remote', [{ op: 'session.remove', sessionId: 'a' }])
  assert.equal(work(activity), 0)
})

test('目录读取失败或快照过期时只保留旧证据，不续期', () => {
  let now = 0
  const activity = new RemotePowerActivity(() => now)
  activity.device(device())
  activity.sidebar('remote', sidebar(row()))
  activity.snapshot()
  now = 100_000
  activity.device({ ...device(), note: '目录未完整读取' })
  activity.sidebar('remote', sidebar(row()))
  assert.equal(activity.snapshot().sources[0]?.observedAgoMs, 100_000)
  activity.device({ ...device(), stale: true })
  assert.equal(activity.snapshot().sources[0]?.unknown, true)
})

function fakeCore() {
  const sinks = new Map<string, HostSink>()
  const core: CoreHost = {
    async command() {
      assert.fail('工作观察不能发出 RPC')
    },
    subscribe(topic, sink) {
      const key = topic.kind === 'app' ? 'app' : 'deviceId' in topic ? topic.deviceId : topic.kind
      sinks.set(key, sink)
      if (topic.kind === 'app') sink.snapshot({ devices: [device('local'), device()] })
      if (topic.kind === 'sidebar') sink.snapshot(sidebar(row()))
      return () => {
        sinks.delete(key)
      }
    },
  }
  return { core, sinks }
}

test('只订阅已有 app/sidebar，移除设备退订，退出释放全部订阅；没有额外请求', () => {
  const { core, sinks } = fakeCore()
  const activity = new RemotePowerActivity()
  const stop = watchRemotePower(core, activity, () => {})
  assert.deepEqual([...sinks.keys()], ['app', 'remote'])
  assert.equal(work(activity), 1)
  sinks.get('app')?.delta([{ op: 'device.remove', deviceId: 'remote' }])
  assert.equal(work(activity), 0)
  assert.deepEqual([...sinks.keys()], ['app'])
  stop()
  assert.equal(sinks.size, 0)
})

test('桌面经隔离本机控制套接字上报，忽略设置广播，状态变化及时发送，正常关闭报空', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'litch-remote-power-'))
  const path = join(directory, 'ctl.sock')
  const frames: { params: ReturnType<RemotePowerActivity['snapshot']> }[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write(`${JSON.stringify({ state: { settings: { secret: 'do-not-log' } } })}\n`)
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const frame = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        assert.equal(frame.method, 'power.remoteActivity')
        frames.push(frame)
        if (!socket.writableEnded) socket.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`)
      }
    })
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const { core, sinks } = fakeCore()
  const logs: string[] = []
  const stop = reportRemotePower(core, path, (line) => logs.push(line))
  t.after(stop)
  await t.waitFor(() => assert.ok(frames.length >= 1), { interval: 5 })
  assert.equal(frames[0]?.params.sources[0]?.working, 1)
  sinks.get('remote')?.delta([{ op: 'session.upsert', session: row('a', 'idle') }])
  await t.waitFor(() => assert.ok(frames.length >= 2), { interval: 5 })
  assert.deepEqual(frames.at(-1)?.params.sources, [])
  stop()
  await t.waitFor(() => assert.ok(frames.length >= 3), { interval: 5 })
  assert.deepEqual(frames.at(-1)?.params.sources, [])
  assert.deepEqual(logs, [])
})
