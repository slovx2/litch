import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FILE_DOWNLOAD_CHUNK } from '../../protocol/src/file-download.mjs'
import { readFileChunk } from '../../shared/src/file-download.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { nativeWirePaths } from '../../shared/src/native-path.mjs'
import { DeviceServer } from '../src/device.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { TestClient } from './helpers.mjs'

test('分块读取：大文件每块有界、空文件、拒绝变化和非法参数', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'big.bin')
  const file = await open(path, 'w')
  await file.truncate(2 ** 32 + 10)
  await file.close()
  const first = await readFileChunk(path, { root, offset: 0, maxBytes: FILE_DOWNLOAD_CHUNK })
  assert.equal(first.litchReadRange.size, 2 ** 32 + 10)
  assert.equal(Buffer.from(first.dataBase64, 'base64').length, FILE_DOWNLOAD_CHUNK)
  const last = await readFileChunk(path, {
    root,
    offset: 2 ** 32,
    maxBytes: FILE_DOWNLOAD_CHUNK,
    revision: first.litchReadRange.revision,
  })
  assert.equal(Buffer.from(last.dataBase64, 'base64').length, 10)
  await writeFile(path, 'new')
  await assert.rejects(
    readFileChunk(path, { root, offset: 0, maxBytes: 10, revision: first.litchReadRange.revision }),
    /changed/,
  )
  await writeFile(path, '')
  assert.equal((await readFileChunk(path, { root, offset: 0, maxBytes: 1 })).dataBase64, '')
  for (const bad of [
    { offset: -1 },
    { offset: 1 },
    { maxBytes: 0 },
    { maxBytes: FILE_DOWNLOAD_CHUNK + 1 },
    { offset: 1.5 },
    { revision: 'no' },
    { extra: true },
  ]) {
    await assert.rejects(readFileChunk(path, { root, offset: 0, maxBytes: 1, ...bad }))
  }
  await assert.rejects(readFileChunk(root, { root, offset: 0, maxBytes: 1 }), /notFile/)
})

test('分块读取：边界、原子替换、声明隔离；标准读取不变', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'litch-download-boundary-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'project')
  await mkdir(root)
  const path = join(root, 'file.txt')
  await writeFile(path, 'old')
  const outside = join(home, 'outside')
  await writeFile(outside, 'secret')
  await symlink(outside, join(root, 'link'))
  for (const file of [outside, join(root, 'link')])
    await assert.rejects(readFileChunk(file, { root, offset: 0, maxBytes: 10 }), /outside/)
  const fs = new FilesystemRpc()
  const official = { id: 'official', send() {}, close() {} }
  const client = { id: 'litch', send() {}, close() {} }
  fs.declare(client, { capabilities: { litchExtensions: ['fileDownload'] } })
  const args = { path, litchReadRange: { root, offset: 0, maxBytes: 3 } }
  await assert.rejects(fs.call(official, 'fs/readFile', args), /未声明/)
  const first = (await fs.call(client, 'fs/readFile', args)) as Awaited<
    ReturnType<typeof readFileChunk>
  >
  assert.equal(Buffer.from(first.dataBase64, 'base64').toString(), 'old')
  assert.deepEqual(await fs.call(official, 'fs/readFile', { path }), { dataBase64: 'b2xk' })
  await writeFile(join(root, 'new'), 'new')
  await rename(join(root, 'new'), path)
  await assert.rejects(
    fs.call(client, 'fs/readFile', {
      ...args,
      litchReadRange: { ...args.litchReadRange, revision: first.litchReadRange.revision },
    }),
    /changed/,
  )
  assert.equal(await readFile(outside, 'utf8'), 'secret')
  fs.closePeer(client.id)
  await assert.rejects(fs.call(client, 'fs/readFile', args), /未声明/)
  assert.deepEqual(
    nativeWirePaths(
      { path: '/C:/work/file', litchReadRange: { root: '/C:/work', offset: 0, maxBytes: 1 } },
      'win32',
    ),
    { path: 'C:/work/file', litchReadRange: { root: 'C:/work', offset: 0, maxBytes: 1 } },
  )
})

test('设备聚合面声明 fileDownload，握手后可分块读，未声明连接不能读', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-download-device-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const device = new DeviceServer({ stateDir: join(root, 'state'), upstreams: [], version: 'test' })
  const socket = join(root, 'device.sock')
  const server = await listenUnix(socket, (wire) => device.attach(wire))
  t.after(async () => {
    await server.close()
    await device.close()
  })
  const client = await TestClient.overSocket(socket)
  t.after(() => client.close())
  await client.initialize(['harness', 'fileDownload'])
  const info = (await client.call('runtime/info', {})) as { device: { extensions: string[] } }
  assert.ok(info.device.extensions.includes('fileDownload'))
  const path = join(root, 'a.bin')
  await writeFile(path, Buffer.from([0, 255, 42]))
  const result = (await client.call('fs/readFile', {
    path,
    litchReadRange: { root, offset: 0, maxBytes: 1 },
  })) as { dataBase64: string; litchReadRange: { size: number } }
  assert.equal(result.dataBase64, 'AA==')
  assert.equal(result.litchReadRange.size, 3)
  const other = await TestClient.overSocket(socket)
  t.after(() => other.close())
  await other.initialize(['harness'])
  assert.match(
    (await other.fails('fs/readFile', { path, litchReadRange: { root, offset: 0, maxBytes: 1 } }))
      .message,
    /未声明/,
  )
})
