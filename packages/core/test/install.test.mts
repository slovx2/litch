// 给设备装 harness（harnessInstall 扩展）在核心这一头：握手声明、看设备的 extensions 决定能不能用、
// 主题开着才问版本、引擎名换成界面的 harness 标识（claude-code → claude）、开始装时换回去、
// 进度跟着通知走、结束后重新问版本、断线重连后设备那边没有了的任务记成 lost。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  HarnessInstallJob,
  HarnessVersionInfo,
} from '../../protocol/src/device-harness-install.mjs'
import {
  type AppView,
  createCore,
  createMockCore,
  type InstallOp,
  type InstallTopicView,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

const CLAUDE: HarnessVersionInfo = {
  harness: 'claude-code',
  installable: true,
  method: 'script',
  installed: null,
  minimum: '2.1.200',
  verified: '2.1.282',
  latest: null,
  docsUrl: 'https://example.com/claude',
  manual: 'curl -fsSL https://example.com/install.sh | bash -s 2.1.282',
}

function world(options: { extensions?: string[] } = {}) {
  const fake = fakeDevice([harness('pi')])
  fake.device.extensions = options.extensions ?? ['harness', 'harnessInstall']
  const state = { jobs: [] as HarnessInstallJob[], installed: null as string | null }
  const peer = fakeOpener({
    ...fake.handlers,
    'litch/device/harness/versions': (params) => ({
      harnesses: [
        {
          ...CLAUDE,
          installed: state.installed,
          latest: (params as { latest?: boolean }).latest ? '2.1.303' : null,
        },
      ],
    }),
    'litch/device/harness/install': () => ({ job: 'j1' }),
    'litch/device/harness/install/read': () => ({ jobs: state.jobs }),
  })
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    devices: [
      {
        id: 'dev',
        name: 'build-01',
        host: 'dev@build-01',
        kind: 'ssh',
        target: { kind: 'alias', alias: 'build-01' },
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId: 'dev', ...params }, never)
  const sent = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  const watch = () => {
    const seen = { view: null as InstallTopicView | null }
    const close = core.subscribe(
      { kind: 'install', deviceId: 'dev' },
      {
        snapshot: (data) => {
          seen.view = data as InstallTopicView
        },
        delta: (ops) => {
          for (const op of ops as InstallOp[]) seen.view = op.view
        },
        error() {},
      },
    )
    return { seen, close }
  }
  return { core, peer, time, state, command, sent, broadcast, watch }
}

async function started(options: { extensions?: string[] } = {}) {
  const w = world(options)
  w.core.start()
  await settle()
  await settle()
  return w
}

const job = (fields: Partial<HarnessInstallJob>): HarnessInstallJob => ({
  job: 'j1',
  harness: 'claude-code',
  version: 'verified',
  resolved: '2.1.282',
  state: 'running',
  command: 'curl … | bash -s 2.1.282',
  log: [],
  startedAt: 1,
  endedAt: null,
  ...fields,
})

test('握手声明 harnessInstall；设备列了它才能用，设备视图带 install；没列的命令以 unsupported 结束', async () => {
  const w = await started()
  const init = w.peer.last().seen.find((entry) => entry.method === 'initialize')
  assert.ok(init)
  const caps = (init.params as { capabilities: { litchExtensions: string[] } }).capabilities
  assert.ok(caps.litchExtensions.includes('harnessInstall'))
  const app = await new Promise<{ devices: { id: string; install: boolean }[] }>((resolve) => {
    w.core.subscribe(
      { kind: 'app' },
      { snapshot: (data) => resolve(data as never), delta() {}, error() {} },
    )
  })
  assert.equal(app.devices[0]?.install, true)

  const bare = await started({ extensions: ['harness'] })
  const { seen } = bare.watch()
  assert.equal(seen.view?.available, false)
  await assert.rejects(bare.command('install.versions'), { code: 'unsupported' })
  await assert.rejects(bare.command('install.start', { harness: 'claude', version: 'verified' }), {
    code: 'unsupported',
  })
  assert.equal(bare.sent('litch/device/harness/versions').length, 0)
})

test('主题开着才问版本；标识照设备给的引擎名（和聚合面的 HarnessView.id 一致）；latest 现查', async () => {
  const w = await started()
  assert.equal(w.sent('litch/device/harness/versions').length, 0, '没人看不问')
  const { seen } = w.watch()
  await settle()
  await settle()
  assert.equal(seen.view?.available, true)
  assert.equal(seen.view?.versions?.[0]?.harness, 'claude-code')
  assert.equal(seen.view?.versions?.[0]?.latest, null)
  const { harnesses } = (await w.command('install.versions', { latest: true })) as {
    harnesses: { harness: string; latest: string | null }[]
  }
  assert.deepEqual(
    harnesses.map((entry) => [entry.harness, entry.latest]),
    [['claude-code', '2.1.303']],
  )
  assert.deepEqual(w.sent('litch/device/harness/versions').at(-1), { latest: true })
  assert.equal(seen.view?.versions?.[0]?.latest, '2.1.303')
})

test('开始装：发的是引擎名；进度跟着通知走；结束后重新问一次版本', async () => {
  const w = await started()
  const { seen } = w.watch()
  await settle()
  await settle()
  const { job: id } = (await w.command('install.start', {
    harness: 'claude-code',
    version: 'verified',
  })) as { job: string }
  assert.equal(id, 'j1')
  assert.deepEqual(w.sent('litch/device/harness/install'), [
    { harness: 'claude-code', version: 'verified' },
  ])
  assert.equal(seen.view?.jobs[0]?.state, 'running')
  assert.equal(seen.view?.jobs[0]?.harness, 'claude-code')

  w.broadcast('litch/device/harness/install/changed', job({ log: ['Downloading…'] }))
  await settle()
  assert.deepEqual(seen.view?.jobs[0]?.log, ['Downloading…'])

  const asked = w.sent('litch/device/harness/versions').length
  w.state.installed = '2.1.282'
  w.broadcast(
    'litch/device/harness/install/changed',
    job({ state: 'succeeded', endedAt: 5, installed: '2.1.282', log: ['done'] }),
  )
  await settle()
  await settle()
  assert.equal(seen.view?.jobs[0]?.state, 'succeeded')
  assert.equal(w.sent('litch/device/harness/versions').length, asked + 1)
  assert.equal(seen.view?.versions?.[0]?.installed, '2.1.282')

  // 失败的原因两种语言都带着
  w.broadcast(
    'litch/device/harness/install/changed',
    job({
      job: 'j2',
      state: 'failed',
      endedAt: 9,
      failure: { 'zh-CN': 'npm 不在 PATH 里', en: 'npm is not on PATH' },
    }),
  )
  await settle()
  assert.deepEqual(
    seen.view?.jobs.map((entry) => [entry.job, entry.state]),
    [['j2', 'failed']],
  )
  assert.equal(seen.view?.jobs[0]?.failure?.en, 'npm is not on PATH')
})

test('断线重连：读任务补上状态；原来在跑、设备那边已经没有了的记成 lost', async () => {
  const w = await started()
  const { seen } = w.watch()
  await settle()
  await settle()
  await w.command('install.start', { harness: 'claude-code', version: 'latest' })
  assert.equal(seen.view?.jobs[0]?.state, 'running')
  w.state.jobs = []
  w.peer.last().drop()
  await settle()
  w.time.advance(500)
  await settle()
  await settle()
  await settle()
  assert.equal(seen.view?.jobs[0]?.state, 'lost')
  assert.ok(seen.view?.versions, '重连后重新问了版本')

  // 设备上还在跑的：照读到的显示
  w.state.jobs = [job({ job: 'j3', log: ['still going'], startedAt: 2_000_000_000_000 })]
  w.peer.last().drop()
  await settle()
  w.time.advance(1000)
  await settle()
  await settle()
  await settle()
  assert.deepEqual(
    seen.view?.jobs.map((entry) => [entry.job, entry.state]),
    [['j3', 'running']],
  )
})

test('模拟核心：fresh 开局本机都没装；装 Claude 日志一行行出来、装好变可用；Codex 固定失败；同时只跑一个', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 10, scene: 'fresh' })
  const command = (name: string, params: object) =>
    core.command(name, { deviceId: 'local', ...params }, never)
  let app: AppView | null = null
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        app = data as AppView
      },
      delta: (ops) => {
        for (const op of ops as { op: string; device?: AppView['devices'][number] }[]) {
          const { device } = op
          if (op.op === 'device.upsert' && device && app) {
            app = { devices: app.devices.map((entry) => (entry.id === device.id ? device : entry)) }
          }
        }
      },
      error() {},
    },
  )
  const local = () => (app as AppView | null)?.devices.find((device) => device.id === 'local')
  assert.ok(local()?.harnesses.every((entry) => entry.state === 'unavailable'))
  const seen = { view: null as InstallTopicView | null }
  core.subscribe(
    { kind: 'install', deviceId: 'local' },
    {
      snapshot: (data) => {
        seen.view = data as InstallTopicView
      },
      delta: (ops) => {
        for (const op of ops as InstallOp[]) seen.view = op.view
      },
      error() {},
    },
  )
  time.advance(100)
  const claude = seen.view?.versions?.find((entry) => entry.harness === 'claude')
  assert.deepEqual([claude?.installed, claude?.verified], [null, '2.1.282'])

  await command('install.start', { harness: 'claude', version: 'verified' })
  await assert.rejects(command('install.start', { harness: 'pi', version: 'verified' }), {
    code: 'busy',
  })
  time.advance(100)
  const running = seen.view?.jobs[0]
  assert.equal(running?.state, 'running')
  assert.ok((running?.log.length ?? 0) > 0 && (running?.log.length ?? 0) < 7)
  time.advance(1000)
  assert.equal(seen.view?.jobs[0]?.state, 'succeeded')
  assert.equal(local()?.harnesses.find((entry) => entry.id === 'claude')?.state, 'ready')
  assert.equal(
    seen.view?.versions?.find((entry) => entry.harness === 'claude')?.installed,
    '2.1.282',
  )

  await command('install.start', { harness: 'codex', version: 'verified' })
  time.advance(2000)
  const failed = seen.view?.jobs.find((entry) => entry.harness === 'codex')
  assert.equal(failed?.state, 'failed')
  assert.match(failed?.failure?.['zh-CN'] ?? '', /EACCES/)
  assert.equal(local()?.harnesses.find((entry) => entry.id === 'codex')?.state, 'unavailable')
})
