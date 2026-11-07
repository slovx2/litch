import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelFailure } from '../src/device/faults.mjs'
import { createFiles, type FilesHost } from '../src/device/files.mjs'
import { transcriptImageTarget } from '../src/media.mjs'
import { fakeClock } from './helpers.mjs'

test('对话图片：相对 cwd、任意绝对路径、中文空格和一次 URI 解码；拒绝逃逸与网络路径', () => {
  const scope = { root: '/work', cwd: '/work/src', roots: ['/work', '/other'] }
  assert.deepEqual(transcriptImageTarget('./中文%20图.png', scope), {
    kind: 'file',
    root: '/work/src',
    path: '/work/src/中文 图.png',
    format: 'image',
  })
  assert.equal(transcriptImageTarget('/tmp/generated', scope).kind, 'file')
  assert.equal(transcriptImageTarget('https://example.org/a.png', scope).kind, 'external')
  assert.equal(transcriptImageTarget('/tmp/a%2520b.png', scope).kind, 'file')
  for (const source of [
    '../a.png',
    '/tmp/../a.png',
    '%2e%2e/a.png',
    '//server/x.png',
    '\\\\server\\x.png',
    'file:///tmp/x.png',
    'data:image/png;base64,YQ==',
    'javascript:a',
    'x%00.png',
    'x%09.png',
    'x%1b.png',
    'x%7f.png',
    '~/x.png',
  ])
    assert.equal(transcriptImageTarget(source, scope).kind, 'blocked', source)
  const windows = transcriptImageTarget('图.png', { root: 'C:/work', cwd: 'C:/work/src' })
  assert.deepEqual(windows, {
    kind: 'file',
    path: 'C:/work/src/图.png',
    root: 'C:/work/src',
    format: 'image',
  })
})

test('mediaImages 声明与旧设备回退：外链零旁路，只有有界本地预览', async () => {
  const asked: { method: string; params: unknown }[] = []
  let images = false,
    preview = false
  const host: FilesHost = {
    clock: fakeClock().clock,
    online: () => true,
    platform: () => 'linux',
    home: () => '/home/test',
    knownRoot: () => true,
    imagesSupported: () => images,
    previewSupported: () => preview,
    request: async (method, params) => {
      asked.push({ method, params })
      return (
        method === 'litch/media/readImage'
          ? { kind: 'ready', format: 'image', bytes: 1, dataBase64: 'YQ==' }
          : { dataBase64: 'YQ==' }
      ) as never
    },
    fail: channelFailure,
    log() {},
  }
  const files = createFiles(host)
  for (const source of ['https://example.com/x.png', '/tmp/a.png'])
    assert.equal((await files.image(source)).kind, 'unsupported')
  assert.equal(asked.length, 0)
  preview = true
  assert.equal((await files.image('/tmp/a.png')).kind, 'ready')
  assert.deepEqual(asked[0], {
    method: 'fs/readFile',
    params: { path: '/tmp/a.png', litchPreview: { root: '/', maxBytes: 8388608 } },
  })
  assert.equal((await files.image('https://example.com/x.png')).kind, 'unsupported')
  images = true
  assert.equal((await files.image('https://example.com/x.png')).kind, 'ready')
  assert.equal(asked[1]?.method, 'litch/media/readImage')
  assert.equal((await files.image('/tmp/../a.png')).kind, 'invalid')
  assert.equal((await files.image('/tmp/a\t.png')).kind, 'invalid')
  assert.equal(asked.length, 2)
})
