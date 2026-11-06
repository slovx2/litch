import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/web/file-preview-image.js', import.meta.url), 'utf8')
function fixture(width = 320, height = 160, format = 'svg') {
  const messages = [],
    images = [],
    viewports = []
  const win = {
    __litchPreview: {
      data: Buffer.from('<svg/>').toString('base64'),
      format,
      checkBudget: true,
      thumbnail: true,
      name: 'svg',
    },
    ReactNativeWebView: { postMessage: (text) => messages.push(JSON.parse(text)) },
    addEventListener() {},
  }
  runInNewContext(source, {
    window: win,
    Uint8Array,
    TextDecoder,
    Blob,
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    IMAGE_BYTES: 8388608,
    svgInfo: () => ({ width, height, mime: 'image/svg+xml' }),
    imageInfo: () => ({ width, height, mime: 'image/jpeg' }),
    setTimeout: () => 0,
    clearTimeout() {},
    previewGestures: (_image, w, h) => {
      viewports.push([w, h])
      return () => {}
    },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    document: {
      body: { style: {}, append() {} },
      createElement: (tag) => {
        if (tag === 'canvas')
          return {
            getContext: () => ({ drawImage() {} }),
            toDataURL: () => 'data:image/png;base64,AAAA',
          }
        const image = { naturalWidth: width, naturalHeight: height }
        images.push(image)
        return image
      },
    },
  })
  return { win, messages, images, viewports }
}

test('SVG 累计预算确认前不创建解码器，批准后缩略图交回原生组件', () => {
  const f = fixture()
  assert.equal(f.images.length, 0)
  assert.deepEqual(f.messages, [{ kind: 'imageInfo', width: 320, height: 160 }])
  f.win.__litchImageAuthorize(true)
  assert.equal(f.images.length, 1)
  f.images[0].onload()
  assert.equal(f.messages[1].kind, 'thumbnail')
  assert.equal(f.messages[2].kind, 'ready')
  assert.equal(f.win.__litchImageAuthorize, undefined)
})

test('拒绝累计预算或单图超过手机上限时不创建图片', () => {
  const denied = fixture()
  denied.win.__litchImageAuthorize(false)
  assert.equal(denied.images.length, 0)
  assert.equal(denied.messages.at(-1).kind, 'failed')
  const huge = fixture(4000, 4000)
  assert.equal(huge.images.length, 0)
  assert.equal(huge.messages[0].kind, 'failed')
})

test('JPEG EXIF 旋转后，视口与缩略图沿用实际解码宽高', () => {
  const f = fixture(320, 160, 'image')
  f.win.__litchImageAuthorize(true)
  Object.assign(f.images[0], { naturalWidth: 160, naturalHeight: 320 })
  f.images[0].onload()
  assert.deepEqual(f.viewports, [[160, 320]])
  assert.equal(f.images[0].width, 160)
  assert.equal(f.images[0].height, 320)
  assert.equal(f.messages.at(-1).kind, 'ready')
})
