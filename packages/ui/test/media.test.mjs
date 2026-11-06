import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageInfo } from '../src/files/preview/image-info.ts'
import { PreviewResources } from '../src/files/preview/resources.ts'

test('手机与桌面复用尺寸预检；坏图与解码炸弹在分配位图前拒绝', () => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xoAAAAASUVORK5CYII=',
    'base64',
  )
  assert.deepEqual(imageInfo(bytes), { mime: 'image/png', width: 1, height: 1 })
  assert.equal(imageInfo(Buffer.from('not image')), null)
  const huge = Buffer.from(bytes)
  huge.writeUInt32BE(5000, 16)
  huge.writeUInt32BE(5000, 20)
  assert.equal(imageInfo(huge), null)
  huge.writeUInt32BE(17000, 16)
  huge.writeUInt32BE(1, 20)
  assert.equal(imageInfo(huge), null)
})

test('消息图片预算：两端独立像素限额，失败/超限状态原样降级，取消队列不继续读取', async () => {
  const mobile = new PreviewResources(async ({ path }) => ({ kind: 'invalid', path }), 4_000_000)
  assert.equal(mobile.claimPixels('one', 3_000_000), true)
  assert.equal(mobile.claimPixels('two', 2_000_000), false)
  assert.equal(
    (await mobile.load({ deviceId: 'a', root: '/', path: '/a.png' }, 'image', true)).kind,
    'invalid',
  )
  mobile.dispose()
  await assert.rejects(mobile.load({ deviceId: 'a', root: '/', path: '/b.png' }, 'image'), {
    name: 'AbortError',
  })
  const desktop = new PreviewResources(async ({ path }) => ({
    kind: 'tooLarge',
    path,
    bytes: 9_000_000,
    limit: 8_388_608,
  }))
  assert.equal(desktop.claimPixels('one', 20_000_000), true)
  assert.equal(desktop.claimPixels('two', 20_000_000), true)
  assert.equal(desktop.claimPixels('three', 1), false)
  assert.equal(
    (await desktop.load({ deviceId: 'b', root: '/', path: '/a.png' }, 'image', true)).kind,
    'tooLarge',
  )
  desktop.dispose()
})

test('重复图片共享 URL，最后使用者离开或会话销毁时恰好释放一次', () => {
  const resources = new PreviewResources(async ({ path }) => ({ kind: 'invalid', path }))
  let made = 0,
    revoked = 0
  const create = () => ({ url: `blob:${++made}`, width: 10, height: 10 })
  const revoke = () => revoked++
  const a = resources.imageLease('image', create, revoke),
    b = resources.imageLease('image', create, revoke)
  assert.equal(a.image.url, b.image.url)
  assert.equal(made, 1)
  a.release()
  assert.equal(revoked, 0)
  resources.dispose()
  assert.equal(revoked, 1)
  b.release()
  assert.equal(revoked, 1)
})
