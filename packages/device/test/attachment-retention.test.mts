import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  ATTACHMENT_RETENTION_MS,
  fileAttachmentsBlock,
} from '../../protocol/src/file-attachments.mjs'
import { RESUME_TOOLS_CHANGED } from '../../protocol/src/resume-tools.mjs'
import { protectedAttachmentOwners } from '../src/attachment-active.mjs'
import { attachmentId } from '../src/attachment-paths.mjs'
import { ATTACHMENT_SWEEP_MS, AttachmentRetention } from '../src/attachment-retention.mjs'
import { type AttachmentOwner, ownerKey } from '../src/attachment-retention-store.mjs'
import { DeviceServer } from '../src/device.mjs'
import type { Connector } from '../src/wire.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { TestClient } from './helpers.mjs'

const DAY = ATTACHMENT_SWEEP_MS
const id = (n: number) => `mabcdefg-abcdefgh-${String(n).padStart(8, '0')}`
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'litch-retention-'))
  const stateDir = join(home, 'state')
  const root = join(home, '.litch', 'attachments')
  await mkdir(stateDir)
  await mkdir(root, { recursive: true })
  const now = Date.now()
  const make = async (n: number, age: number) => {
    const dir = join(root, id(n))
    await mkdir(dir)
    const file = join(dir, 'report.txt')
    await writeFile(file, '附件')
    await utimes(dir, new Date(now - age), new Date(now - age))
    return { dir, file }
  }
  return { home, root, stateDir, now, make }
}
const observed = (threadId: string, path: string) => ({
  threadId,
  input: [
    {
      type: 'text',
      text: fileAttachmentsBlock([{ name: 'report.txt', path, location: 'device' }]),
    },
  ],
})

test('启动与每日清理：只删除超过 30 天的编号目录，墓碑跨重启保留', async () => {
  assert.equal(ATTACHMENT_RETENTION_MS, 30 * DAY)
  const f = await fixture()
  let now = f.now
  let tick = () => {}
  let stopped = false
  const old = await f.make(1, 31 * DAY),
    fresh = await f.make(2, 29 * DAY),
    boundary = await f.make(3, 30 * DAY)
  await mkdir(join(f.root, 'manual-files'))
  await writeFile(join(f.root, 'loose.txt'), '保留')
  const options = {
    ...f,
    now: () => now,
    inUse: () => false,
    protectedOwners: async () => new Set<string>(),
    interval: (fn: () => void, ms: number) => {
      assert.equal(ms, DAY)
      tick = fn
      return () => {
        stopped = true
      }
    },
  }
  let retention = new AttachmentRetention(options)
  try {
    await retention.start()
    assert.equal(await exists(old.dir), false)
    assert.equal(await exists(fresh.dir), true)
    assert.equal(await exists(boundary.dir), true)
    assert.equal(await exists(join(f.root, 'manual-files')), true)
    assert.equal(await exists(join(f.root, 'loose.txt')), true)
    assert.deepEqual(await retention.status(old.file), { state: 'cleaned' })
    assert.deepEqual(await retention.status(join(f.root, id(99), 'missing')), { state: 'unknown' })
    now += 2 * DAY
    tick()
    await retention.sweep()
    assert.equal(await exists(fresh.dir), false)
    await retention.close()
    assert.equal(stopped, true)
    retention = new AttachmentRetention(options)
    assert.deepEqual(await retention.status(old.file), { state: 'cleaned' })
  } finally {
    await retention.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('多个所属会话中任一个打开或正在执行就跳过，引用刷新修改时间', async () => {
  const f = await fixture()
  let now = f.now
  let open = true
  let running = true
  const a = await f.make(1, 0),
    b = await f.make(2, 0)
  let ownerCount = 0
  const options = {
    ...f,
    now: () => now,
    inUse: (o: AttachmentOwner) => open && o.threadId === 'open',
    protectedOwners: async (owners: AttachmentOwner[]) => {
      ownerCount = owners.length
      return new Set(running ? [ownerKey({ harness: 'pi', threadId: 'running' })] : [])
    },
  }
  let retention = new AttachmentRetention(options)
  try {
    retention.observe('pi', observed('open', a.file))
    retention.observe('pi', observed('other', a.file))
    retention.observe('pi', observed('running', b.file))
    await retention.close()
    retention = new AttachmentRetention(options)
    now += 31 * DAY
    await retention.sweep()
    assert.equal(ownerCount, 3)
    assert.equal(await exists(a.dir), true)
    assert.equal(await exists(b.dir), true)
    assert.ok(Math.abs((await stat(a.dir)).mtimeMs - now) < 1)
    open = false
    running = false
    now += 31 * DAY
    await retention.sweep()
    assert.equal(await exists(a.dir), false)
    assert.equal(await exists(b.dir), false)
  } finally {
    await retention.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('软链、目录越界与扫描期间替换均拒绝，不影响外部文件', async () => {
  const f = await fixture()
  const outside = join(f.home, 'outside')
  await mkdir(outside)
  const target = join(outside, 'keep')
  await writeFile(target, '不能删')
  const nested = await f.make(1, 31 * DAY)
  await symlink(target, join(nested.dir, 'linked'))
  await utimes(nested.dir, new Date(f.now - 31 * DAY), new Date(f.now - 31 * DAY))
  await symlink(outside, join(f.root, id(2)))
  const swapped = await f.make(3, 0)
  let now = f.now
  const retention = new AttachmentRetention({
    ...f,
    now: () => now,
    inUse: () => false,
    protectedOwners: async () => {
      await rename(swapped.dir, join(outside, 'saved'))
      await symlink(outside, swapped.dir)
      return new Set()
    },
  })
  try {
    retention.observe('pi', observed('idle', swapped.file))
    await retention.sweep()
    now += 31 * DAY
    await retention.sweep()
    assert.equal(await exists(nested.file), true)
    assert.equal(await readFile(target, 'utf8'), '不能删')
    assert.equal(attachmentId(f.home, join(f.root, '..', id(1), 'report.txt')), null)
    assert.equal(attachmentId(f.home, `${f.root}/${id(1)}/../${id(3)}/report.txt`), null)
    assert.deepEqual(await retention.status(join(outside, 'keep')), { state: 'unknown' })
    await rename(f.root, join(f.home, 'saved-root'))
    await symlink(outside, f.root)
    await retention.sweep()
    assert.equal(await readFile(target, 'utf8'), '不能删')
  } finally {
    await retention.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('清理前查询正在运行的引擎；活动会话、后台任务和无法判断的入口均受保护', async () => {
  const owners = ['running', 'background', 'idle'].map((threadId) => ({ harness: 'pi', threadId }))
  const calls: string[] = []
  const connect: Connector = async (handlers) => ({
    send(raw) {
      const frame = JSON.parse(raw)
      calls.push(frame.method)
      if (frame.id === undefined) return
      const result =
        frame.method === 'initialize'
          ? {}
          : {
              threads: [
                { threadId: 'running', active: true, background: false },
                { threadId: 'background', active: false, background: true },
                { threadId: 'idle', active: false, background: false },
              ],
            }
      queueMicrotask(() => handlers.message(JSON.stringify({ id: frame.id, result })))
    },
    close() {},
  })
  const protectedKeys = await protectedAttachmentOwners(
    owners,
    [{ id: 'pi', running: true, connect }],
    'test',
  )
  assert.deepEqual([...protectedKeys].sort(), owners.slice(0, 2).map(ownerKey).sort())
  assert.ok(!calls.includes('thread/list'))
  const unavailable = await protectedAttachmentOwners(
    owners,
    [
      {
        id: 'pi',
        running: true,
        connect: async () => {
          throw new Error('offline')
        },
      },
    ],
    'test',
  )
  assert.equal(unavailable.size, 3)
})

test('状态接口按连接声明隔离，设备启动清理后返回已清理且不泄露到普通 fs 应答', async () => {
  const f = await fixture()
  const old = await f.make(1, 31 * DAY)
  const device = new DeviceServer({ stateDir: f.stateDir, attachmentHome: f.home, upstreams: [] })
  const declared = new TestClient(device),
    plain = new TestClient(device)
  try {
    await declared.initialize(['harness', 'fileAttachments'])
    await plain.initialize(['harness'])
    const info = await declared.call('runtime/info')
    assert.ok(info.device.extensions.includes('fileAttachments'))
    await device.attachments.start()
    assert.deepEqual(await declared.call('litch/attachments/status', { path: old.file }), {
      state: 'cleaned',
    })
    assert.match(
      (await plain.fails('litch/attachments/status', { path: old.file })).message,
      /未声明/,
    )
    assert.match(
      (await plain.fails('litch/attachments/watch', { threadId: 'a', open: true })).message,
      /未声明/,
    )
    assert.deepEqual(
      await declared.call('litch/attachments/watch', { threadId: 'a', open: true }),
      {},
    )
    assert.deepEqual(
      await declared.call('litch/attachments/watch', { threadId: 'a', open: false }),
      {},
    )
    const error = await plain.fails('fs/getMetadata', { path: old.file })
    assert.equal('state' in error, false)
    assert.deepEqual(
      declared.notifications.filter((n) => n.method === 'litch/attachments/status'),
      [],
    )
  } finally {
    declared.close()
    plain.close()
    await device.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

for (const route of ['client', 'internal'] as const) {
  test(`${route} 路由：恢复工具协调与附件历史、视图保活、活动探针共存`, async () => {
    const f = await fixture()
    const history = await f.make(1, 0),
      sent = await f.make(2, 0)
    const pi = new FakeUpstream('pi')
    let active = false
    pi.threads = [{ id: 'thread', updatedAt: 1 }]
    const resume = pi.handlers['thread/resume']
    assert.ok(resume)
    pi.handlers['thread/resume'] = (params, connection) => ({
      ...(resume(params, connection) as object),
      thread: {
        id: 'thread',
        updatedAt: 1,
        turns: [
          { items: [{ type: 'userMessage', content: observed('thread', history.file).input }] },
        ],
      },
    })
    pi.handlers['thread/unsubscribe'] = () => ({ status: 'unsubscribed' })
    pi.handlers['litch/internal/power/activity'] = () => ({
      threads: [{ threadId: 'thread', active, background: false }],
    })
    const device = new DeviceServer({
      stateDir: f.stateDir,
      attachmentHome: f.home,
      importExisting: false,
      clientToolSettings: { 'tools.machine': true },
      upstreams: [{ id: 'pi', connect: pi.connector }],
    })
    const client = new TestClient(device)
    const internal = route === 'internal' ? await device.openEngineLink('pi') : null
    const call = (method: string, params: Record<string, unknown>) =>
      internal ? internal.request(method, params) : client.call(method, params)
    const db = new DatabaseSync(join(f.stateDir, 'attachments.sqlite'))
    const age = async () => {
      db.prepare('UPDATE attachments SET used_at=?').run(f.now - 31 * DAY)
      for (const entry of [history, sent])
        await utimes(entry.dir, new Date(f.now - 31 * DAY), new Date(f.now - 31 * DAY))
    }
    try {
      await client.initialize(['harness', 'fileAttachments'])
      await call('thread/resume', { threadId: 'thread', harness: 'pi' })
      assert.ok(
        device.sessionTree.store.tools('thread')?.some((t: any) => t.name === 'litch_machine'),
      )
      // 两条连接都必须观察工具生效通知；附件快照登记不能取代恢复协调器。
      pi.notify(RESUME_TOOLS_CHANGED, {
        threadId: 'thread',
        instance: 'fake',
        revision: 2,
        dynamicTools: [],
      })
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(device.sessionTree.store.tools('thread'), [])
      if (internal) await client.call('litch/attachments/watch', { threadId: 'thread', open: true })
      await call('turn/start', {
        threadId: 'thread',
        input: observed('thread', sent.file).input,
      })
      await device.attachments.sweep()
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owners').get()?.n, 2)
      await age()
      await device.attachments.sweep()
      assert.equal(await exists(history.file), true)
      assert.equal(await exists(sent.file), true)
      if (internal)
        await client.call('litch/attachments/watch', { threadId: 'thread', open: false })
      else await client.call('thread/unsubscribe', { threadId: 'thread' })
      active = true
      await age()
      await device.attachments.sweep()
      assert.equal(await exists(history.file), true)
      assert.equal(await exists(sent.file), true)
      active = false
      pi.notify('turn/completed', {
        threadId: 'thread',
        turn: { id: 'turn-of-thread', status: 'completed' },
      })
      await new Promise((resolve) => setImmediate(resolve))
      await age()
      await device.attachments.sweep()
      assert.equal(await exists(history.file), false)
      assert.equal(await exists(sent.file), false)
    } finally {
      db.close()
      internal?.close()
      client.close()
      await device.close()
      await rm(f.home, { recursive: true, force: true })
    }
  })
}

test('.litch 父目录软链也不跟随，外部附件目录保持原样', async () => {
  const f = await fixture()
  const outside = join(f.home, 'outside')
  const victim = join(outside, 'attachments', id(1))
  await mkdir(victim, { recursive: true })
  await writeFile(join(victim, 'keep.txt'), '保留')
  await utimes(victim, new Date(f.now - 31 * DAY), new Date(f.now - 31 * DAY))
  await rename(join(f.home, '.litch'), join(f.home, 'original-litch'))
  await symlink(outside, join(f.home, '.litch'))
  const retention = new AttachmentRetention({
    ...f,
    now: () => f.now,
    inUse: () => false,
    protectedOwners: async () => new Set(),
  })
  try {
    await retention.start()
    assert.equal(await readFile(join(victim, 'keep.txt'), 'utf8'), '保留')
    assert.deepEqual(await retention.status(join(f.root, id(1), 'keep.txt')), { state: 'unknown' })
  } finally {
    await retention.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('只读会话视图按连接保活；关闭一个窗口不影响另一个，断线解除保护', async () => {
  const f = await fixture()
  let now = f.now
  const item = await f.make(1, 0)
  const retention = new AttachmentRetention({
    ...f,
    now: () => now,
    inUse: () => false,
    protectedOwners: async () => new Set(),
  })
  try {
    retention.observe('pi', observed('archived', item.file))
    await retention.sweep()
    retention.watch('desktop', 'archived', true)
    retention.watch('phone', 'archived', true)
    now += 31 * DAY
    await retention.sweep()
    assert.equal(await exists(item.file), true)
    retention.watch('desktop', 'archived', false)
    now += 31 * DAY
    await retention.sweep()
    assert.equal(await exists(item.file), true)
    retention.left('phone')
    now += 31 * DAY
    await retention.sweep()
    assert.equal(await exists(item.file), false)
  } finally {
    await retention.close()
    await rm(f.home, { recursive: true, force: true })
  }
})
