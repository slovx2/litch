import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcError } from '../src/connection/rpc.mjs'
import { createFileReconciler, FILE_RECONCILE_MS } from '../src/device/file-reconcile.mjs'
import type { FilesHost } from '../src/device/files.mjs'
import { ChannelError } from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

const metadata = (modifiedAtMs = 100, createdAtMs = 1) => ({
  isFile: true,
  isDirectory: false,
  isSymlink: false,
  createdAtMs,
  modifiedAtMs,
})
function fixture(read: (path: string) => Promise<unknown>) {
  const time = fakeClock()
  const requests: string[] = []
  const host: FilesHost = {
    clock: time.clock,
    online: () => true,
    platform: () => 'macos',
    home: () => '/',
    knownRoot: () => true,
    log() {},
    fail: (e) => new ChannelError('remote', String(e)),
    async request(method, params) {
      assert.equal(method, 'fs/getMetadata', '对账本身不得枚举目录或读取文件内容')
      const path = (params as { path: string }).path
      requests.push(path)
      return (await read(path)) as never
    },
  }
  const reconcile = createFileReconciler(host)
  const tick = async () => {
    time.advance(FILE_RECONCILE_MS)
    await settle()
  }
  return { time, requests, reconcile, tick }
}

test('漏事件：内容修改、同 mtime 原子替换、删除、重建；不变时只 stat', async () => {
  let value = metadata()
  let missing = false
  const w = fixture(async () => {
    if (missing) throw new RpcError(-32603, 'ENOENT')
    return value
  })
  let changes = 0
  const stop = w.reconcile.open('/root/file', () => changes++)
  await settle()
  assert.equal(changes, 1)
  await w.tick()
  assert.equal(changes, 1)
  value = metadata(200)
  await w.tick()
  assert.equal(changes, 2)
  value = metadata(200, 2)
  await w.tick()
  assert.equal(changes, 3)
  missing = true
  await w.tick()
  assert.equal(changes, 4)
  await w.tick()
  assert.equal(changes, 4)
  missing = false
  await w.tick()
  assert.equal(changes, 5)
  stop()
  assert.equal(w.time.pending(), 0)
  const count = w.requests.length
  await w.tick()
  assert.equal(w.requests.length, count)
})

test('一千个已展开目录：同路径复用 stat、并发不超过四个、慢请求不积压轮次', async () => {
  const pending: (() => void)[] = []
  let running = 0,
    peak = 0
  const w = fixture(async () => {
    peak = Math.max(peak, ++running)
    await new Promise<void>((resolve) => pending.push(resolve))
    running--
    return metadata()
  })
  const stops = Array.from({ length: 1000 }, (_, i) => w.reconcile.open(`/root/dir-${i}`, () => {}))
  const shared = w.reconcile.open('/root/dir-0', () => {})
  assert.equal(w.requests.length, 4)
  w.time.advance(FILE_RECONCILE_MS * 100)
  assert.equal(w.requests.length, 4)
  while (pending.length) {
    for (const release of pending.splice(0)) release()
    await settle()
  }
  assert.equal(w.requests.length, 1000)
  assert.equal(peak, 4)
  assert.equal(w.time.pending(), 1)
  for (const stop of stops) stop()
  shared()
  assert.equal(w.time.pending(), 0)
})

test('焦点补读只管选定根；在途请求之后合并一次补读', async () => {
  let release: (() => void) | undefined
  let slow = false
  const w = fixture(async () => {
    if (slow)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return metadata()
  })
  let changes = 0,
    other = 0
  const stop = w.reconcile.open('/root/file', () => changes++)
  const stopOther = w.reconcile.open('/root-other/file', () => other++)
  await settle()
  slow = true
  w.reconcile.refresh('/root')
  w.reconcile.refresh('/root')
  w.reconcile.refresh('/root')
  assert.equal(w.requests.length, 3)
  slow = false
  release?.()
  await settle()
  assert.equal(w.requests.length, 4)
  assert.equal(changes, 3)
  assert.equal(other, 1)
  stop()
  stopOther()
})

test('断线与关闭时丢弃迟到 stat；重连重新建立基线', async () => {
  let release: (() => void) | undefined
  let slow = true
  const w = fixture(async () => {
    if (slow)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return metadata()
  })
  let changes = 0
  const stop = w.reconcile.open('/root/file', () => changes++)
  w.reconcile.offline()
  slow = false
  release?.()
  await settle()
  await w.tick()
  assert.equal(changes, 0)
  assert.equal(w.requests.length, 1)
  w.reconcile.resync()
  await settle()
  assert.equal(changes, 1)
  slow = true
  w.reconcile.refresh('/root')
  stop()
  release?.()
  await settle()
  assert.equal(changes, 1)
  assert.equal(w.time.pending(), 0)
})

test('瞬时失败不冒充删除；没有时间戳时低频补读', async () => {
  let error: RpcError | undefined
  const w = fixture(async () => {
    if (error) throw error
    return metadata(0, 0)
  })
  let changes = 0
  const stop = w.reconcile.open('/root/file', () => changes++)
  await settle()
  await w.tick()
  assert.equal(changes, 2)
  error = new RpcError(-32603, 'EACCES')
  await w.tick()
  assert.equal(changes, 2)
  error = undefined
  await w.tick()
  assert.equal(changes, 3)
  stop()
})
