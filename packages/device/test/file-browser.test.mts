import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'

test('有界目录读取按连接声明，截断枚举；标准读取响应不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'litch-browser-budget-'))
  await Promise.all(Array.from({ length: 27 }, (_, n) => mkdir(join(root, String(n)))))
  const rpc = new FilesystemRpc()
  const peer = { id: 'declared', send() {}, close() {} }
  const other = { id: 'standard', send() {}, close() {} }
  rpc.declare(peer, { capabilities: { litchExtensions: ['fileBrowser', 'filePreview'] } })
  const params = { path: root, litchDirectory: { maxEntries: 10 } }
  await assert.rejects(rpc.call(other, 'fs/readDirectory', params), /未声明/)
  const result = (await rpc.call(peer, 'fs/readDirectory', params)) as any
  assert.equal(result.entries.length, 10)
  assert.deepEqual(result.litchDirectory, { truncated: true })
  const whole = (await rpc.call(other, 'fs/readDirectory', { path: root })) as any
  assert.equal(whole.entries.length, 27)
  assert.deepEqual(Object.keys(whole), ['entries'])
  for (const maxEntries of [0, -1, 2001, 1.5, '10'])
    await assert.rejects(
      rpc.call(peer, 'fs/readDirectory', { path: root, litchDirectory: { maxEntries } }),
      /预算无效/,
    )
  rpc.close()
})

test('巨型稀疏文本在设备检查句柄大小即拒绝，普通文本返回有界内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'litch-browser-text-'))
  const path = join(root, 'huge.log')
  const handle = await open(path, 'w')
  await handle.truncate(2 ** 30)
  await handle.close()
  const rpc = new FilesystemRpc()
  const peer = { id: 'text', send() {}, close() {} }
  rpc.declare(peer, { capabilities: { litchExtensions: ['filePreview'] } })
  await assert.rejects(
    rpc.call(peer, 'fs/readFile', { path, litchPreview: { root, maxBytes: 2 ** 21 } }),
    (error: any) =>
      error.data?.litchPreview?.kind === 'tooLarge' && error.data.litchPreview.bytes === 2 ** 30,
  )
  await writeFile(join(root, 'small.txt'), 'bounded')
  assert.deepEqual(
    await rpc.call(peer, 'fs/readFile', {
      path: join(root, 'small.txt'),
      litchPreview: { root, maxBytes: 100 },
    }),
    { dataBase64: Buffer.from('bounded').toString('base64') },
  )
  rpc.close()
})
