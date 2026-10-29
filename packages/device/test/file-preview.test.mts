import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readPreview } from '../../shared/src/file-preview.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { nativeWirePaths } from '../../shared/src/native-path.mjs'
import { DeviceServer } from '../src/device.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { TestClient } from './helpers.mjs'

test('预览在设备端拒绝越根、外链符号链接、特殊路径和超限；根内链接仍能读', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'litch-preview-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'project')
  await mkdir(root)
  const file = join(root, '测试 report.md'),
    outside = join(home, 'secret')
  await writeFile(file, '# report')
  await writeFile(outside, 'must not read')
  const insideLink = join(root, 'inside.md'),
    outsideLink = join(root, 'outside.md')
  await symlink(file, insideLink)
  await symlink(outside, outsideLink)
  const read = (path: string, maxBytes = 100) => readPreview(path, { root, maxBytes })
  assert.equal(Buffer.from((await read(file)).dataBase64, 'base64').toString(), '# report')
  assert.deepEqual(await read(insideLink), await read(file))
  for (const path of [outside, outsideLink])
    await assert.rejects(read(path), (e: any) => e.data?.litchPreview.kind === 'outside')
  await assert.rejects(read(root), (e: any) => e.data?.litchPreview.kind === 'notFile')
  await assert.rejects(
    read(file, 2),
    (e: any) => e.data?.litchPreview.kind === 'tooLarge' && e.data.litchPreview.limit === 2,
  )
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, 21 * 1024 * 1024])
    await assert.rejects(read(file, maxBytes))
  await assert.rejects(readPreview(file, { root: '//server/share', maxBytes: 10 }))
  const big = join(root, 'huge.png'),
    handle = await open(big, 'w')
  await handle.truncate(1024 ** 3)
  await handle.close()
  await assert.rejects(read(big, 1024), (e: any) => e.data?.litchPreview.bytes === 1024 ** 3)
  const missing = join(root, 'missing.md')
  await assert.rejects(read(missing), (e: any) => e.code === 'ENOENT')
})

test('标准 fs 形状不变；声明按连接隔离并在关闭后清除', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-preview-wire-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'image'),
    bytes = Buffer.from([0, 255, 1, 2])
  await writeFile(path, bytes)
  const fs = new FilesystemRpc()
  const official = { id: 'official', send() {}, close() {} }
  const litch = { ...official, id: 'litch' }
  const params = { path, litchPreview: { root, maxBytes: 4 } }
  fs.declare(litch, { capabilities: { litchExtensions: ['filePreview'] } })
  assert.deepEqual(await fs.call(official, 'fs/readFile', { path }), {
    dataBase64: bytes.toString('base64'),
  })
  await assert.rejects(fs.call(official, 'fs/readFile', params), (e: any) => e.code === -32602)
  assert.deepEqual(await fs.call(litch, 'fs/readFile', params), {
    dataBase64: bytes.toString('base64'),
  })
  fs.closePeer(litch.id)
  await assert.rejects(fs.call(litch, 'fs/readFile', params))
  // 聚合面的声明直接来自该连接，不借用其他入口的登记。
  assert.deepEqual(await fs.call(official, 'fs/readFile', params, true), {
    dataBase64: bytes.toString('base64'),
  })
})

test('真实设备套接字：声明、限量、结构化错误与二进制响应', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'lpf-'))
  const root = join(home, 'work')
  await mkdir(root)
  const path = join(root, 'image.png')
  await writeFile(path, Buffer.from([0, 255, 1, 2]))
  const server = new DeviceServer({ stateDir: join(home, 'state'), upstreams: [] })
  const socket = join(home, 'device.sock')
  const listener = await listenUnix(socket, (wire) => server.attach(wire))
  const client = await TestClient.overSocket(socket)
  t.after(async () => {
    client.close()
    await listener.close()
    await server.close()
    await rm(home, { recursive: true, force: true })
  })
  await client.initialize(['harness', 'filePreview'])
  const info = await client.call('runtime/info')
  assert(info.device.extensions.includes('filePreview'))
  const result = await client.call('fs/readFile', { path, litchPreview: { root, maxBytes: 4 } })
  assert.deepEqual(result, { dataBase64: 'AP8BAg==' })
  const error = await client.fails('fs/readFile', { path, litchPreview: { root, maxBytes: 1 } })
  assert.equal(error.data?.litchPreview?.kind, 'tooLarge')
})

test('Windows 设备的预览 root 与 path 一起恢复盘符', () => {
  assert.deepEqual(
    nativeWirePaths(
      { path: '/C:/work/a.md', litchPreview: { root: '/C:/work', maxBytes: 10 } },
      'win32',
    ),
    { path: 'C:/work/a.md', litchPreview: { root: 'C:/work', maxBytes: 10 } },
  )
})

test('读取期间增长/删除文件，不返回过期或不完整的内容', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-preview-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'changed.md')
  await writeFile(path, 'original')
  const probe = await open(path, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  let mutated = false
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args)
    if (!mutated) {
      mutated = true
      await writeFile(path, 'x'.repeat(200))
    }
    return result
  })
  await assert.rejects(
    readPreview(path, { root, maxBytes: 100 }),
    (e: any) => e.data?.litchPreview.kind === 'tooLarge',
  )
  t.mock.restoreAll()
  await writeFile(path, 'original')
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args)
    await rm(path, { force: true })
    return result
  })
  await assert.rejects(readPreview(path, { root, maxBytes: 100 }), (e: any) => e.code === 'ENOENT')
})
