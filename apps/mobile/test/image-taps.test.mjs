import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageTaps } from '../src/detail/media/image-taps.ts'

test('图片单击等待双击窗口后关闭；放大状态不改变关闭规则', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  let closed = 0,
    zoomed = 0
  const taps = imageTaps(
    () => closed++,
    () => zoomed++,
  )
  taps.tap()
  ctx.mock.timers.tick(299)
  assert.equal(closed, 0)
  ctx.mock.timers.tick(1)
  assert.equal(closed, 1)
  taps.tap()
  ctx.mock.timers.tick(100)
  taps.tap()
  assert.equal(zoomed, 1)
  ctx.mock.timers.tick(400)
  assert.equal(closed, 1)
  taps.tap()
  ctx.mock.timers.tick(300)
  assert.equal(closed, 2)
})

test('图片开始拖动、捏合或卸载时取消待执行的单击', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  let closed = 0
  const taps = imageTaps(
    () => closed++,
    () => assert.fail('不应双击'),
  )
  taps.tap()
  taps.cancel()
  ctx.mock.timers.tick(1000)
  assert.equal(closed, 0)
  taps.tap()
  ctx.mock.timers.tick(300)
  assert.equal(closed, 1)
})

test('原生附件：双指缩放和拖动不触发关闭，双击复位后单击关闭', async (ctx) => {
  const { attachmentGestures } = await import('../src/detail/media/attachment-gestures.ts')
  ctx.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let position,
    closed = 0
  const gesture = attachmentGestures(
    (value) => {
      position = value
    },
    () => closed++,
  )
  const one = [{ pageX: 100, pageY: 100 }]
  const pair = [...one, { pageX: 200, pageY: 100 }]
  gesture.grant(one)
  gesture.add(pair)
  gesture.move([...one, { pageX: 300, pageY: 100 }])
  assert.equal(position.scale, 2)
  gesture.move(one)
  gesture.release()
  ctx.mock.timers.tick(500)
  assert.equal(closed, 0)
  gesture.grant(one)
  gesture.add(pair)
  gesture.release()
  ctx.mock.timers.tick(500)
  assert.equal(closed, 0, '未移动的多指松手也不关')
  gesture.grant(one)
  gesture.move([{ pageX: 150, pageY: 130 }])
  gesture.release()
  ctx.mock.timers.tick(500)
  assert.equal(closed, 0)
  assert.equal(position.scale, 2)
  gesture.grant(one)
  gesture.release()
  ctx.mock.timers.tick(100)
  gesture.grant(one)
  gesture.release()
  ctx.mock.timers.tick(400)
  assert.deepEqual(position, { x: 0, y: 0, scale: 1 })
  assert.equal(closed, 0)
  gesture.grant(one)
  gesture.cancel()
  gesture.release()
  ctx.mock.timers.tick(400)
  assert.equal(closed, 0)
  gesture.grant(one)
  gesture.release()
  ctx.mock.timers.tick(300)
  assert.equal(closed, 1)
})
