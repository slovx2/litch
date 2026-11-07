import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PREVIEW_LIMIT } from '@litch/core'
import { channelFailure } from '../../../packages/core/src/device/faults.mts'
import { createFiles } from '../../../packages/core/src/device/files.mts'
import { imageInfo } from '../../../packages/ui/src/files/preview/image-info.ts'
import {
  mobilePreviewFormat,
  previewEvent,
  previewFailure,
} from '../src/screens/files/preview/model.ts'

const binary = (path) => ({ kind: 'binary', path, group: 'binary', bytes: null })
test('手机按共享后缀分流：图片/SVG/PDF；其他格式不进入预览', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'PNG', 'JPEG'])
    assert.equal(mobilePreviewFormat(binary(`/work/a.${ext}`)), 'image')
  assert.equal(mobilePreviewFormat(binary('/work/a.PDF')), 'pdf')
  assert.equal(mobilePreviewFormat(binary('/work/a.svg')), 'svg')
  for (const ext of ['docx', 'xlsx', 'mp3', 'mp4', 'zip', 'html', 'bin'])
    assert.equal(mobilePreviewFormat(binary(`/work/a.${ext}`)), null)
  assert.equal(mobilePreviewFormat({ kind: 'missing', path: '/work/a.pdf' }), null)
  assert.equal(mobilePreviewFormat({ kind: 'directory', path: '/work/a.pdf' }), null)
  assert.equal(
    mobilePreviewFormat({ kind: 'text', path: '/work/a.svg', text: '<svg/>', bytes: 6 }),
    'svg',
  )
})

test('图片/SVG/PDF 分别守 8/1/20 MiB，不能靠谎报 bytes 绕过 base64 预算', () => {
  for (const format of ['image', 'svg', 'pdf']) {
    const ready = { kind: 'ready', format, bytes: 1, dataBase64: 'YQ==' }
    assert.equal(previewFailure(ready, format), null)
    assert.equal(previewFailure({ ...ready, bytes: PREVIEW_LIMIT[format] + 1 }, format), 'tooLarge')
    assert.equal(
      previewFailure(
        { ...ready, dataBase64: 'A'.repeat(Math.ceil(PREVIEW_LIMIT[format] / 3) * 4 + 4) },
        format,
      ),
      'tooLarge',
    )
    assert.equal(previewFailure({ ...ready, bytes: 0 }, format), 'invalid')
    assert.equal(previewFailure({ ...ready, format: 'html' }, format), 'invalid')
  }
})

test('旧设备能力降级：不发读取请求；新设备发送 litchPreview 预算', async () => {
  let supported = false
  const asked = []
  const files = createFiles({
    clock: { now: () => 0, setTimer: () => () => {} },
    online: () => true,
    platform: () => 'linux',
    home: () => '/work',
    knownRoot: () => true,
    previewSupported: () => supported,
    request: async (method, params) => {
      asked.push({ method, params })
      return { dataBase64: 'YQ==' }
    },
    fail: channelFailure,
    log() {},
  })
  const old = await files.preview('/work', '/work/a.png', 'image')
  assert.equal(previewFailure(old, 'image'), 'unsupported')
  assert.deepEqual(asked, [])
  supported = true
  assert.equal((await files.preview('/work', '/work/a.pdf', 'pdf')).kind, 'ready')
  assert.deepEqual(asked, [
    {
      method: 'fs/readFile',
      params: { path: '/work/a.pdf', litchPreview: { root: '/work', maxBytes: PREVIEW_LIMIT.pdf } },
    },
  ])
})

test('共享图片核对拒绝损坏头、过大像素和动画帧', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xoAAAAASUVORK5CYII=',
    'base64',
  )
  assert.deepEqual(imageInfo(png), { mime: 'image/png', width: 1, height: 1 })
  const huge = Buffer.from(png)
  huge.writeUInt32BE(20000, 16)
  assert.equal(imageInfo(huge), null)
  const pixels = Buffer.from(png)
  pixels.writeUInt32BE(5000, 16)
  pixels.writeUInt32BE(5000, 20)
  assert.equal(imageInfo(pixels), null)
  assert.equal(imageInfo(Buffer.from('broken image')), null)
  assert.equal(imageInfo(png.subarray(0, 30)), null)
  const animated = Buffer.from(png)
  animated.write('acTL', 37)
  assert.equal(imageInfo(animated), null)
})

test('WebView 消息不允许任意状态、导航或超过预算的页码', () => {
  assert.deepEqual(previewEvent('{"kind":"ready","page":2,"pages":5}'), {
    kind: 'ready',
    page: 2,
    pages: 5,
  })
  for (const reason of ['encrypted', 'invalid', 'imageInvalid', 'pages', 'size', 'timeout'])
    assert.deepEqual(previewEvent(JSON.stringify({ kind: 'failed', reason })), {
      kind: 'failed',
      reason,
    })
  for (const data of [
    'null',
    '{}',
    'bad',
    '{"kind":"ready","page":0,"pages":2}',
    '{"kind":"ready","page":1,"pages":201}',
    '{"kind":"failed","reason":"navigate"}',
  ])
    assert.equal(previewEvent(data), null)
})
