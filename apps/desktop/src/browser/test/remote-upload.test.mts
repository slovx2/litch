import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import {
  UPLOAD_CHUNK_BYTES,
  type UploadReadParams,
  type UploadReadResult,
} from '../../../../../packages/protocol/src/browser-upload.mjs'
import { prepareRemoteUpload } from '../../client-tools/upload-source.mjs'

test('假远程成功分块、同名路径不读桌面、保留文件名/时间/字节，dispose 清理', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-upload-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 7, 43)
  const reads: UploadReadParams[] = []
  const read = async (params: UploadReadParams): Promise<UploadReadResult> => {
    reads.push(params)
    assert.equal(params.path, '/remote-only/source.txt')
    return {
      size: bytes.length,
      version: 'v1',
      mtimeMs: 1700000000000,
      ...(params.action === 'read'
        ? {
            dataBase64: bytes
              .subarray(params.offset, params.offset + params.length)
              .toString('base64'),
          }
        : {}),
    }
  }
  const staged = await prepareRemoteUpload(
    ['/remote-only/source.txt'],
    { fileBytes: bytes.length, totalBytes: bytes.length },
    read,
    new AbortController().signal,
    root,
  )
  assert.equal(basename(staged.paths[0]!), 'source.txt')
  assert.deepEqual(await readFile(staged.paths[0]!), bytes)
  assert.equal((await stat(staged.paths[0]!)).mtimeMs, 1700000000000)
  assert.deepEqual(
    reads.filter((r) => r.action === 'read').map((r) => r.action === 'read' && r.length),
    [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 7, 0],
  )
  await staged.dispose()
  assert.deepEqual(await readdir(root), [])
})

test('桌面同路径存在不同内容时，也只采用绑定设备返回的字节', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-upload-same-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'same.txt')
  await writeFile(path, 'DESKTOP_PRIVATE_BYTES')
  const remote = Buffer.from('REMOTE_BYTES')
  const staged = await prepareRemoteUpload(
    [path],
    { fileBytes: 100, totalBytes: 100 },
    async (params) => ({
      size: remote.length,
      version: 'remote',
      mtimeMs: 0,
      ...(params.action === 'read'
        ? {
            dataBase64: remote
              .subarray(params.offset, params.offset + params.length)
              .toString('base64'),
          }
        : {}),
    }),
    new AbortController().signal,
    root,
  )
  assert.equal(await readFile(staged.paths[0]!, 'utf8'), 'REMOTE_BYTES')
  await staged.dispose()
  assert.equal(await readFile(path, 'utf8'), 'DESKTOP_PRIVATE_BYTES')
})

for (const failure of [
  'fileLimit',
  'totalLimit',
  'disconnect',
  'cancel',
  'missing',
  'changed',
  'invalidChunk',
]) {
  test(`假远程 ${failure} 不交出文件并清理全部暂存`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'litch-upload-failure-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const controller = new AbortController()
    let chunks = 0
    const read = async (params: UploadReadParams): Promise<UploadReadResult> => {
      if (failure === 'missing') throw new Error('ENOENT remote source')
      if (params.action === 'read') {
        chunks++
        if (failure === 'disconnect') throw new Error('Device disconnected')
        if (failure === 'cancel') controller.abort()
        if (failure === 'changed')
          return { size: 4, version: 'v2', mtimeMs: 0, dataBase64: 'YWJjZA==' }
        return { size: 4, version: 'v1', mtimeMs: 0, dataBase64: 'invalid' }
      }
      return { size: 4, version: 'v1', mtimeMs: 0 }
    }
    await assert.rejects(
      prepareRemoteUpload(
        ['/remote/source.txt', '/remote/other.txt'],
        {
          fileBytes: failure === 'fileLimit' ? 3 : 4,
          totalBytes: failure === 'totalLimit' ? 7 : 8,
        },
        read,
        controller.signal,
        root,
      ),
    )
    assert.deepEqual(await readdir(root), [])
    if (['fileLimit', 'totalLimit', 'missing'].includes(failure)) assert.equal(chunks, 0)
  })
}
