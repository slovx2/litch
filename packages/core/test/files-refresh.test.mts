import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  type FileContent,
  type FileRow,
  keys,
  observeFileChanges,
  serveChannel,
  textToBase64,
} from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { runtimeInfo } from './world.mjs'

const root = '/work/app'
async function setup(kind: 'local' | 'ssh' = 'local', extra: Record<string, Handler> = {}) {
  const dirs = new Map<string, string[]>([
    [root, ['src/', 'before.txt']],
    [`${root}/src`, ['index.ts']],
  ])
  const contents = new Map([
    [`${root}/before.txt`, 'before'],
    [`${root}/src/index.ts`, 'old'],
  ])
  const time = fakeClock()
  const handlers: Record<string, Handler> = {
    'runtime/info': () => runtimeInfo(),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({ data: [], nextCursor: null, backwardsCursor: null }),
    'model/list': () => ({ data: [], nextCursor: null }),
    'fs/readDirectory': (p) => {
      const entries = dirs.get((p as { path: string }).path)
      if (!entries) throw new RpcFailure(-32603, 'ENOENT')
      return {
        entries: entries.map((name) => ({
          fileName: name.replace(/\/$/, ''),
          isFile: !name.endsWith('/'),
          isDirectory: name.endsWith('/'),
        })),
      }
    },
    'fs/getMetadata': (p) => {
      const path = (p as { path: string }).path
      if (!contents.has(path) && !dirs.has(path)) throw new RpcFailure(-32603, 'ENOENT')
      return { isFile: contents.has(path), isDirectory: dirs.has(path) }
    },
    'fs/readFile': (p) => ({
      dataBase64: textToBase64(contents.get((p as { path: string }).path) ?? ''),
    }),
    'fs/watch': () => ({}),
    'fs/unwatch': () => ({}),
    ...extra,
  }
  const peer = fakeOpener(handlers)
  const core = createCore({
    clock: time.clock,
    version: 'test',
    devices: [
      { id: 'device', kind, name: '夹具', host: '', target: null, wire: 'green', open: peer.open },
    ],
  })
  core.start()
  await settle()
  const [ui, port] = createPortPair()
  const stopServer = serveChannel(port, core, { clock: time.clock })
  const channel = connectChannel(ui)
  const replica = createReplica(channel)
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params)
  const watches = () =>
    (sent('fs/watch') as { watchId: string; path: string }[]).filter(
      (watch) =>
        !(sent('fs/unwatch') as { watchId: string }[]).some(
          (entry) => entry.watchId === watch.watchId,
        ),
    )
  const change = async (path: string) => {
    for (const watch of watches())
      peer.last().notify('fs/changed', { watchId: watch.watchId, changedPaths: [path] })
    await settle()
  }
  const flush = async () => {
    await settle()
    time.advance(250)
    await settle()
  }
  const rows = () => replica.store.get<FileRow[]>(keys.fileRows('device', root)) ?? []
  const close = () => {
    channel.close()
    stopServer()
    core.stop()
  }
  return {
    dirs,
    contents,
    handlers,
    time,
    peer,
    core,
    channel,
    replica,
    sent,
    watches,
    change,
    flush,
    rows,
    close,
  }
}

test('完全没有 fs/changed：对账更新可见目录与打开文件，焦点补读不用等待下一轮', async (t) => {
  const w = await setup()
  t.after(w.close)
  const stop = w.replica.files.open('device', root)
  let text = ''
  const stopFile = observeFileChanges(
    w.channel,
    { deviceId: 'device', root, path: `${root}/before.txt` },
    async () => {
      const content = await w.channel.command('files.read', {
        deviceId: 'device',
        root,
        path: `${root}/before.txt`,
      })
      text = content.kind === 'text' ? content.text : content.kind
    },
    true,
  )
  await w.flush()
  w.dirs.set(root, ['renamed.txt'])
  w.contents.delete(`${root}/before.txt`)
  w.time.advance(5000)
  await w.flush()
  assert.deepEqual(
    w.rows().map((row) => row.name),
    ['renamed.txt'],
  )
  assert.equal(text, 'missing')
  w.contents.set(`${root}/before.txt`, 'atomic replacement')
  w.dirs.set(root, ['before.txt'])
  await w.channel.command('files.reconcile', { deviceId: 'device', root })
  await w.flush()
  assert.equal(text, 'atomic replacement')
  assert.deepEqual(
    w.rows().map((row) => row.name),
    ['before.txt'],
  )
  stop()
  stopFile()
  await w.flush()
  const count = w.sent('fs/getMetadata').length
  w.time.advance(15000)
  await w.flush()
  assert.equal(w.sent('fs/getMetadata').length, count)
})

for (const kind of ['local', 'ssh'] as const) {
  test(`${kind}：目录增删重命名、保留展开与稳定行 ID、收起和退出退订`, async (t) => {
    const w = await setup(kind)
    t.after(w.close)
    const stop = w.replica.files.open('device', root)
    await w.flush()
    assert.deepEqual(
      w.rows().map((row) => row.name),
      ['src', 'before.txt'],
    )
    w.replica.files.expand('device', root, `${root}/src`)
    await w.flush()
    assert.deepEqual(
      w
        .watches()
        .map((watch) => watch.path)
        .sort(),
      [root, `${root}/src`],
    )
    const id = w.rows().find((row) => row.name === 'before.txt')?.id
    w.dirs.set(root, ['src/', 'new/', 'after.txt'])
    await w.change(`${root}/after.txt`)
    await w.flush()
    assert.deepEqual(
      w.rows().map((row) => row.name),
      ['new', 'src', 'index.ts', 'after.txt'],
    )
    assert.equal(w.rows().find((row) => row.name === 'src')?.expanded, true)
    w.dirs.set(root, ['renamed/', 'src/', 'before.txt'])
    await w.change(`${root}/new`)
    await w.flush()
    assert.equal(w.rows().find((row) => row.name === 'before.txt')?.id, id)
    assert.ok(w.rows().some((row) => row.name === 'renamed'))
    w.dirs.set(root, ['before.txt'])
    await w.change(`${root}/src`)
    await w.flush()
    assert.deepEqual(
      w.watches().map((watch) => watch.path),
      [root],
    )
    w.dirs.set(root, ['src/', 'before.txt'])
    await w.change(`${root}/src`)
    await w.flush()
    w.replica.files.collapse('device', root, `${root}/src`)
    await settle()
    assert.deepEqual(
      w.watches().map((watch) => watch.path),
      [root],
    )
    stop()
    await settle()
    assert.equal(w.watches().length, 0)
  })
}

test('文件修改、删除、重建、重命名：只更新目标，文件与目录共用父目录监视', async (t) => {
  const w = await setup()
  t.after(w.close)
  const stopTree = w.replica.files.open('device', root)
  let content: FileContent | undefined
  let reads = 0
  const stop = observeFileChanges(
    w.channel,
    { deviceId: 'device', root, path: `${root}/before.txt` },
    async () => {
      content = await w.channel.command('files.read', {
        deviceId: 'device',
        root,
        path: `${root}/before.txt`,
      })
      reads++
    },
    true,
  )
  await w.flush()
  const text = () => (content?.kind === 'text' ? content.text : content?.kind)
  assert.equal(text(), 'before')
  assert.equal(w.watches().length, 1)
  const before = reads
  await w.change(`${root}/unrelated.txt`)
  await w.flush()
  assert.equal(reads, before)
  w.contents.set(`${root}/before.txt`, 'new')
  for (let n = 0; n < 100; n++) await w.change(`${root}/before.txt`)
  await w.flush()
  assert.equal(reads, before + 1)
  assert.equal(text(), 'new')
  w.contents.delete(`${root}/before.txt`)
  await w.change(`${root}/before.txt`)
  await w.flush()
  assert.equal(text(), 'missing')
  w.contents.set(`${root}/before.txt`, 'again')
  await w.change(`${root}/before.txt`)
  await w.flush()
  assert.equal(text(), 'again')
  w.contents.set(`${root}/renamed.txt`, 'again')
  w.contents.delete(`${root}/before.txt`)
  await w.change(`${root}/before.txt`)
  await w.flush()
  assert.equal(text(), 'missing')
  stopTree()
  await settle()
  assert.equal(w.watches().length, 1)
  stop()
  await settle()
  assert.equal(w.watches().length, 0)
})

test('慢读取期间的变化串行补读一次，关闭会取消排队的补读', async (t) => {
  const w = await setup()
  t.after(w.close)
  let reads = 0
  let release = () => {}
  const stop = observeFileChanges(
    w.channel,
    { deviceId: 'device', root, path: `${root}/before.txt` },
    () => {
      reads++
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
    true,
  )
  await w.flush()
  for (let n = 0; n < 5; n++) {
    await w.change(`${root}/before.txt`)
    await w.flush()
  }
  assert.equal(reads, 1)
  release()
  await settle()
  assert.equal(reads, 2)
  await w.change(`${root}/before.txt`)
  await w.flush()
  stop()
  release()
  await settle()
  assert.equal(reads, 2)
})

test('断线重连重建监视并刷新；迟到的旧通知不影响新订阅', async (t) => {
  const w = await setup()
  t.after(w.close)
  const stop = w.replica.files.open('device', root)
  await w.flush()
  const old = w.watches()[0]?.watchId
  w.peer.last().drop()
  await settle()
  w.dirs.set(root, ['new.txt'])
  w.time.advance(5000)
  await w.flush()
  assert.deepEqual(
    w.rows().map((row) => row.name),
    ['new.txt'],
  )
  const before = w.sent('fs/readDirectory').length
  w.peer.last().notify('fs/changed', { watchId: old, changedPaths: [root] })
  await w.flush()
  assert.equal(w.sent('fs/readDirectory').length, before)
  stop()
})

test('设备不支持监视仍能读取和手动刷新，不轮询重试', async (t) => {
  const w = await setup('local', {
    'fs/watch': () => {
      throw new RpcFailure(-32601, 'Method not found')
    },
  })
  t.after(w.close)
  const stop = w.replica.files.open('device', root)
  await w.flush()
  w.time.advance(30000)
  await settle()
  assert.equal(w.sent('fs/watch').length, 1)
  w.dirs.set(root, ['new.txt'])
  await w.replica.files.refresh('device', root)
  assert.deepEqual(
    w.rows().map((row) => row.name),
    ['new.txt'],
  )
  stop()
})

test('关掉后才回来的监视应答会释放', async (t) => {
  let armed: ((value: object) => void) | undefined
  const w = await setup('local', {
    'fs/watch': () =>
      new Promise((resolve) => {
        armed = resolve
      }),
  })
  t.after(w.close)
  const stop = w.replica.files.open('device', root)
  await settle()
  stop()
  await settle()
  armed?.({ path: root })
  await w.flush()
  assert.equal(w.watches().length, 0)
  assert.equal(w.sent('fs/unwatch').length, 2)
})

test('读取中变更会作废旧请求缓存，最终显示新目录', async (t) => {
  const w = await setup()
  t.after(w.close)
  const stop = w.replica.files.open('device', root)
  await w.flush()
  let release: ((result: object) => void) | undefined
  const normal = w.handlers['fs/readDirectory']
  assert.ok(normal)
  w.handlers['fs/readDirectory'] = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const old = w.channel.command('files.list', { deviceId: 'device', root, path: root, fresh: true })
  await settle()
  w.handlers['fs/readDirectory'] = normal
  w.dirs.set(root, ['new.txt'])
  await w.change(root)
  await w.flush()
  release?.({ entries: [{ fileName: 'old.txt', isFile: true, isDirectory: false }] })
  await old
  const latest = await w.channel.command('files.list', { deviceId: 'device', root, path: root })
  assert.deepEqual(
    latest.entries.map((entry) => entry.name),
    ['new.txt'],
  )
  assert.deepEqual(
    w.rows().map((row) => row.name),
    ['new.txt'],
  )
  stop()
})

test('预览复用父目录监视时，不能搭上订阅之前的旧文件读取', async (t) => {
  const w = await setup()
  t.after(w.close)
  const stopTree = w.replica.files.open('device', root)
  await w.flush()
  const normal = w.handlers['fs/readFile']
  assert.ok(normal)
  let release: ((result: object) => void) | undefined
  w.handlers['fs/readFile'] = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const location = { deviceId: 'device', root, path: `${root}/before.txt` }
  const previous = w.channel.command('files.read', location)
  await settle()
  w.handlers['fs/readFile'] = normal
  w.contents.set(location.path, 'latest')
  await w.change(location.path)
  await w.flush()
  let text = ''
  const stop = observeFileChanges(
    w.channel,
    location,
    async () => {
      const content = await w.channel.command('files.read', location)
      if (content.kind === 'text') text = content.text
    },
    true,
  )
  await w.flush()
  assert.equal(text, 'latest')
  release?.({ dataBase64: textToBase64('old') })
  await previous
  assert.equal(text, 'latest')
  stop()
  stopTree()
})
