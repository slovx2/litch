import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CoreHost, FileSaveProgress } from '@litch/core'
import { FILE_DOWNLOAD_CHUNK } from '../../../../packages/protocol/src/file-download.mjs'
import { readFileChunk } from '../../../../packages/shared/src/file-download.mjs'
import { saveFileLocally } from '../file-save-core.mjs'

const revision = 'a'.repeat(64)
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'litch-file-save-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('多块另存、进度、原子覆盖；远程路径只作为来源', async (t) => {
  const root = await fixture(t),
    source = join(root, 'source.bin'),
    destination = join(root, 'local-copy.bin')
  const data = Buffer.alloc(FILE_DOWNLOAD_CHUNK * 3 + 13, 42)
  await writeFile(source, data)
  await writeFile(destination, 'old')
  let calls = 0
  const core: Pick<CoreHost, 'command'> = {
    async command(method, raw) {
      assert.equal(method, 'files.readChunk')
      const params = raw as { deviceId: string; path: string; offset: number; revision?: string }
      assert.equal(params.deviceId, 'remote-device')
      assert.equal(params.path, source)
      assert.equal((await readFile(destination)).toString(), 'old')
      calls++
      return readFileChunk(source, {
        root,
        offset: params.offset,
        maxBytes: FILE_DOWNLOAD_CHUNK,
        ...(params.revision ? { revision: params.revision } : {}),
      })
    },
  }
  const progress: FileSaveProgress[] = []
  await saveFileLocally(
    core,
    { id: 'save', source: { deviceId: 'remote-device', root, path: source }, destination },
    new AbortController().signal,
    (value) => progress.push(value),
  )
  assert.equal(calls, 4)
  assert.deepEqual(await readFile(destination), data)
  assert.deepEqual(await readFile(source), data)
  assert.equal(progress.at(-1)?.state, 'saved')
  assert.equal(progress.at(-1)?.bytes, data.length)
  assert.equal(progress.at(-1)?.total, data.length)
  assert.deepEqual((await readdir(root)).sort(), ['local-copy.bin', 'source.bin'])
})
test('失败、取消和恶意响应保留已有文件并清理临时文件', async (t) => {
  const root = await fixture(t),
    destination = join(root, 'keep.txt')
  for (const mode of ['fail', 'cancel', 'invalid'] as const) {
    await writeFile(destination, 'keep')
    const abort = new AbortController(),
      progress: FileSaveProgress[] = []
    let calls = 0
    const core: Pick<CoreHost, 'command'> = {
      async command() {
        calls++
        if (mode === 'invalid')
          return {
            dataBase64: 'A'.repeat(FILE_DOWNLOAD_CHUNK * 2),
            litchReadRange: { size: 1, revision },
          }
        if (calls === 2) {
          if (mode === 'cancel') abort.abort()
          throw Error('source changed')
        }
        return {
          dataBase64: Buffer.alloc(FILE_DOWNLOAD_CHUNK).toString('base64'),
          litchReadRange: { size: FILE_DOWNLOAD_CHUNK + 10, revision },
        }
      },
    }
    await saveFileLocally(
      core,
      { id: mode, source: { deviceId: 'remote', root: '/remote', path: '/remote/a' }, destination },
      abort.signal,
      (value) => progress.push(value),
    )
    assert.equal(progress.at(-1)?.state, mode === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(await readFile(destination, 'utf8'), 'keep')
    assert.deepEqual(await readdir(root), ['keep.txt'])
  }
})
test('空文件和本地写入失败', async (t) => {
  const root = await fixture(t)
  const core: Pick<CoreHost, 'command'> = {
    async command() {
      return { dataBase64: '', litchReadRange: { size: 0, revision } }
    },
  }
  for (const destination of [join(root, 'empty'), join(root, 'absent', 'file')]) {
    const progress: FileSaveProgress[] = []
    await saveFileLocally(
      core,
      { id: 'empty', source: { deviceId: 'd', root: '/r', path: '/r/a' }, destination },
      new AbortController().signal,
      (value) => progress.push(value),
    )
    if (destination.endsWith('empty')) {
      assert.equal(progress.at(-1)?.state, 'saved')
      assert.equal((await readFile(destination)).length, 0)
    } else {
      assert.equal(progress.at(-1)?.state, 'failed')
      assert.match(progress.at(-1)?.error ?? '', /ENOENT/)
    }
  }
})
