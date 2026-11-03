import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FILE_DOWNLOAD_CHUNK } from '../../protocol/src/file-download.mjs'
import { ChannelError, createFiles, type FilesHost } from '../src/index.mjs'
import { fakeClock } from './helpers.mjs'

const revision = 'a'.repeat(64)
const setup = (request: FilesHost['request'], supported = true) =>
  createFiles({
    clock: fakeClock().clock,
    online: () => true,
    platform: () => null,
    home: () => null,
    knownRoot: () => true,
    downloadSupported: () => supported,
    request,
    log() {},
    fail: () => new ChannelError('remote', 'failed'),
  })

test('不支持分块时不读取整文件；出界请求也不发给设备', async () => {
  let calls = 0
  const files = setup(async () => {
    calls++
    return {} as never
  }, false)
  await assert.rejects(files.chunk('/work', '/work/a.bin', 0), { code: 'unsupported' })
  await assert.rejects(files.chunk('/work', '/secret', 0), { code: 'rejected' })
  assert.equal(calls, 0)
})

test('只调用 fs/readFile 的有界扩展，携带取消信号和上块 revision', async () => {
  const abort = new AbortController()
  const files = setup(async (method, params, options) => {
    assert.equal(method, 'fs/readFile')
    assert.deepEqual(params, {
      path: '/work/a.bin',
      litchReadRange: { root: '/work', offset: 5, maxBytes: FILE_DOWNLOAD_CHUNK, revision },
    })
    assert.equal(options?.signal, abort.signal)
    return { dataBase64: 'Yg==', litchReadRange: { size: 6, revision } } as never
  })
  assert.equal(
    (await files.chunk('/work', '/work/a.bin', 5, revision, abort.signal)).dataBase64,
    'Yg==',
  )
})

test('拒绝过大、截断、无进展、混合版本与伪造的块响应', async () => {
  for (const result of [
    { dataBase64: 'YQ==' },
    { dataBase64: 'YQ==', litchReadRange: { size: 2, revision } },
    { dataBase64: '', litchReadRange: { size: 1, revision } },
    { dataBase64: '?', litchReadRange: { size: 1, revision } },
    { dataBase64: 'YQ==', litchReadRange: { size: 1, revision: 'b'.repeat(64) } },
    {
      dataBase64: 'A'.repeat(FILE_DOWNLOAD_CHUNK * 2),
      litchReadRange: { size: FILE_DOWNLOAD_CHUNK, revision },
    },
  ]) {
    const files = setup(async () => result as never)
    await assert.rejects(files.chunk('/work', '/work/a.bin', 0, revision), { code: 'remote' })
  }
})
