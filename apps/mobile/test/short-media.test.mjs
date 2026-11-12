import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHORT_MEDIA_BYTES, shortMediaType } from '@litch/core'
import { shortMediaDocument, shortMediaEvent } from '../src/media/short-media-document.ts'
import { copyExportChunks } from '../src/platform/file-export.ts'

test('短媒体内容探测与严格消息；离线文档不含网络、原生控件或 seek', () => {
  const wav = new Uint8Array(44)
  wav.set(new TextEncoder().encode('RIFF'))
  wav.set(new TextEncoder().encode('WAVE'), 8)
  const type = shortMediaType('misnamed.mp4', wav)
  assert.equal(type.mime, 'audio/wav')
  assert.equal(SHORT_MEDIA_BYTES, 16 * 1024 * 1024)
  const html = shortMediaDocument('YQ==', type, '#fff')
  assert.ok(html.includes("connect-src 'none'"))
  assert.ok(html.includes('media.controls=false'))
  assert.ok(html.includes('media.duration>config.seconds'))
  assert.ok(!html.includes('currentTime='))
  assert.equal(shortMediaEvent('{"kind":"ready"}'), null)
  assert.equal(shortMediaEvent('{"litchShortMedia":true,"kind":"playing","value":"true"}'), null)
  assert.deepEqual(
    shortMediaEvent('{"litchShortMedia":true,"kind":"failed","reason":"mediaDuration"}'),
    { kind: 'failed', reason: 'mediaDuration' },
  )
})

test('另存逐块写入且绑定 revision；取消、来源替换或空块都停止', async () => {
  const source = { deviceId: 'remote', root: '/outside', path: '/outside/file.wav' },
    revision = 'a'.repeat(64)
  const writes = [],
    offsets = []
  const channel = {
    command: async (_name, params) => {
      assert.equal(params.deviceId, 'remote')
      offsets.push(params.offset)
      if (params.offset) assert.equal(params.revision, revision)
      return {
        dataBase64: Buffer.from(params.offset ? 'b' : 'a').toString('base64'),
        litchReadRange: { size: 2, revision },
      }
    },
  }
  await copyExportChunks(
    channel,
    source,
    (bytes) => writes.push(Buffer.from(bytes).toString()),
    new AbortController().signal,
    () => {},
  )
  assert.deepEqual(writes, ['a', 'b'])
  assert.deepEqual(offsets, [0, 1])
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    copyExportChunks(
      channel,
      source,
      () => assert.fail(),
      abort.signal,
      () => {},
    ),
    /cancelled/,
  )
  for (const mode of ['changed', 'empty']) {
    const bad = {
      command: async (_name, params) => ({
        dataBase64: mode === 'empty' || params.offset ? '' : 'YQ==',
        litchReadRange: { size: 2, revision: params.offset ? 'b'.repeat(64) : revision },
      }),
    }
    await assert.rejects(
      copyExportChunks(
        bad,
        source,
        () => {},
        new AbortController().signal,
        () => {},
      ),
      /changed/,
    )
  }
})
