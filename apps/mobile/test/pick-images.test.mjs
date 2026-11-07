import assert from 'node:assert/strict'
import { test } from 'node:test'
import { options, setResult } from 'expo-image-picker'
import { pickImages } from '../src/detail/composer/images.ts'

// 原生 Expo iOS 多选返回原文件的 MIME/名称，但 base64 已转成 JPEG。
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString('base64')
const asset = (overrides = {}) => ({
  uri: 'file:///cache/photo.heic',
  mimeType: 'image/heic',
  fileName: '照片.HEIC',
  fileSize: 100,
  base64: jpeg,
  ...overrides,
})
const select = (...assets) => setResult({ canceled: false, assets })

test('iOS HEIC 与 PNG 转出的 JPEG 使用真实 MIME 和名称', async () => {
  for (const extension of ['HEIC', 'PNG']) {
    select(asset({ mimeType: `image/${extension.toLowerCase()}`, fileName: `照片.${extension}` }))
    const result = await pickImages(4)
    assert.deepEqual(result, {
      images: [{ url: `data:image/jpeg;base64,${jpeg}`, name: '照片.jpg' }],
      refused: null,
    })
    assert.deepEqual(options.mediaTypes, ['images'])
    assert.equal(options.base64, true)
    assert.equal(options.selectionLimit, 4)
  }
})

test('缺 MIME、ph:// 路径和限制访问时缺 assetId 不影响已有的图片字节', async () => {
  select(asset({ mimeType: undefined, uri: 'ph://selected', fileName: null, assetId: null }))
  assert.deepEqual(await pickImages(1), {
    images: [{ url: `data:image/jpeg;base64,${jpeg}`, name: null }],
    refused: null,
  })
})

test('Android 原样返回 PNG、GIF、WebP 时保留实际格式', async () => {
  for (const [type, header, name] of [
    ['png', '\x89PNG\r\n\x1a\n', 'a.png'],
    ['gif', 'GIF89a', 'a.gif'],
    ['webp', 'RIFF\x04\0\0\0WEBP', 'a.webp'],
  ]) {
    const data = Buffer.from(header, 'latin1').toString('base64')
    select(asset({ base64: data, mimeType: `image/${type}`, fileName: name }))
    assert.deepEqual(await pickImages(1), {
      images: [{ url: `data:image/${type};base64,${data}`, name }],
      refused: null,
    })
  }
})

test('按发送字节限制大小，扣掉 base64 padding，不以原文件大小拒绝转码结果', async () => {
  const limit = 8 * 1024 * 1024
  select(asset({ fileSize: limit + 1 }))
  assert.equal((await pickImages(1)).refused, null)
  for (const length of [limit, limit + 1]) {
    const bytes = Buffer.alloc(length)
    bytes.set([0xff, 0xd8, 0xff])
    select(asset({ base64: bytes.toString('base64'), fileSize: 10 }))
    assert.equal((await pickImages(1)).refused, length === limit ? null : 'size')
  }
})

test('取消、读取失败、未知格式、超张数有明确结果，混选保留成功图片', async () => {
  setResult({ canceled: true, assets: null })
  assert.equal(await pickImages(1), null)
  setResult(new Error('native picker failed'))
  assert.equal((await pickImages(1)).refused, 'open')
  select(asset({ base64: null }))
  assert.equal((await pickImages(1)).refused, 'read')
  select(asset({ base64: 'aW52YWxpZA==' }), asset())
  const partial = await pickImages(2)
  assert.equal(partial.refused, 'type')
  assert.equal(partial.images.length, 1)
  select(asset(), asset())
  assert.equal((await pickImages(1)).refused, 'count')
  setResult(new Error('must not open'))
  assert.deepEqual(await pickImages(0), { images: [], refused: 'count' })
  assert.equal(options, undefined)
})

test('原生选图完成后的读取或编码异常不误报成相册打不开', async () => {
  for (const code of [
    'ERR_FAILED_TO_READ_IMAGE',
    'ERR_FAILED_TO_READ_IMAGE_DATA_FOR_BASE64',
    'ERR_FAILED_TO_WRITE_IMAGE',
    'ERR_FAILED_TO_READ_FILE',
  ]) {
    setResult(Object.assign(new Error('private file path must not enter UI'), { code }))
    assert.deepEqual(await pickImages(1), { images: [], refused: 'read' })
  }
})
