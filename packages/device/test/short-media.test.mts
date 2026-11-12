import assert from 'node:assert/strict'
import { mkdtemp, open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SHORT_MEDIA_BYTES } from '../../protocol/src/file-preview.mjs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'

test('短媒体先探测内容；声明、16 MiB 预算和标准响应互不混用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'litch-short-media-'))
  const wav = Buffer.alloc(64)
  wav.write('RIFF')
  wav.write('WAVE', 8)
  await writeFile(join(root, 'audio.mp4'), wav)
  await writeFile(join(root, 'fake.mp4'), '<html>不是媒体</html>')
  const rpc = new FilesystemRpc(),
    peer = { id: 'media', send() {}, close() {} },
    official = { id: 'official', send() {}, close() {} }
  rpc.declare(peer, { capabilities: { litchExtensions: ['shortMedia'] } })
  const params = {
    path: join(root, 'audio.mp4'),
    litchShortMedia: { root, maxBytes: SHORT_MEDIA_BYTES },
  }
  await assert.rejects(rpc.call(official, 'fs/readFile', params), /shortMedia/)
  assert.deepEqual(await rpc.call(peer, 'fs/readFile', params), {
    dataBase64: wav.toString('base64'),
  })
  await assert.rejects(
    rpc.call(peer, 'fs/readFile', { ...params, path: join(root, 'fake.mp4') }),
    (error: any) => error.data?.litchShortMedia?.kind === 'notFile' && !error.data.litchPreview,
  )
  const file = await open(join(root, 'huge.wav'), 'w')
  await file.write(wav)
  await file.truncate(SHORT_MEDIA_BYTES + 1)
  await file.close()
  await assert.rejects(
    rpc.call(peer, 'fs/readFile', { ...params, path: join(root, 'huge.wav') }),
    (error: any) => error.data?.litchShortMedia?.kind === 'tooLarge',
  )
  await assert.rejects(
    rpc.call(peer, 'fs/readFile', {
      ...params,
      litchShortMedia: { root, maxBytes: SHORT_MEDIA_BYTES + 1 },
    }),
    /预算/,
  )
  const standard = (await rpc.call(official, 'fs/readFile', {
    path: join(root, 'fake.mp4'),
  })) as any
  assert.deepEqual(Object.keys(standard), ['dataBase64'])
  rpc.close()
})
