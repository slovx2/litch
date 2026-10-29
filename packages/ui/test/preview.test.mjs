import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageInfo } from '../src/files/preview/image-info.ts'
import { PreviewResources } from '../src/files/preview/resources.ts'

test('位图预检：静态小图、伪扩展、截断、动画与超大像素', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xoAAAAASUVORK5CYII=',
    'base64',
  )
  assert.equal(imageInfo(png)?.mime, 'image/png')
  assert.equal(imageInfo(Buffer.from('<svg/>')), null)
  assert.equal(imageInfo(png.subarray(0, 30)), null)
  const huge = Buffer.from(png)
  huge.writeUInt32BE(30_000, 16)
  assert.equal(imageInfo(huge), null)
  const animated = Buffer.from(png)
  animated.write('acTL', 37)
  assert.equal(imageInfo(animated), null)
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  assert.equal(imageInfo(gif)?.mime, 'image/gif')
})

test('预览资源：附图数量预算、最多两次并发、dispose 取消并清空', async () => {
  let running = 0,
    peak = 0,
    calls = 0
  const resources = new PreviewResources(async ({ path }, format, signal) => {
    running++
    calls++
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 3))
    running--
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    return { kind: 'ready', path, format, dataBase64: 'YQ==', bytes: 1 }
  })
  const scope = { deviceId: 'a', root: '/work', path: '/work/a.png' }
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      resources.load({ ...scope, path: `/work/${i}.png` }, 'image', true),
    ),
  )
  assert.equal(peak, 2)
  assert.equal(calls, 16)
  assert.equal(outcomes.filter((v) => v.kind === 'tooLarge').length, 4)
  resources.dispose()
  await assert.rejects(resources.load(scope, 'image'), { name: 'AbortError' })
})

test('同一资源并发搭车、跨 root 不共用，累计像素与取消排队均受限', async () => {
  let calls = 0
  const resources = new PreviewResources(async ({ path }, format, signal) => {
    calls++
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new DOMException('Cancelled', 'AbortError'))
        },
        { once: true },
      )
    })
    return { kind: 'ready', path, format, bytes: 1, dataBase64: 'YQ==' }
  })
  const scope = { deviceId: 'remote', root: '/work', path: '/work/image.png' }
  await Promise.all([resources.load(scope, 'image', true), resources.load(scope, 'image', true)])
  assert.equal(calls, 1)
  await resources.load({ ...scope, root: '/' }, 'image', true)
  assert.equal(calls, 2)
  assert(resources.claimPixels('a', 20_000_000))
  assert(resources.claimPixels('b', 20_000_000))
  assert.equal(resources.claimPixels('c', 1), false)
  const pending = Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      resources.load({ ...scope, path: `/work/${i}.png` }, 'image', true),
    ),
  )
  resources.dispose()
  assert((await pending).every((value) => value.status === 'rejected'))
})
