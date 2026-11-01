import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolObservation } from '../src/tool-observation.mjs'

test('控制请求先到时等正文及对应工具被处理，其他工具不能提前放行', async () => {
  const tools = new ToolObservation()
  const controller = new AbortController()
  const order: string[] = []
  const ready = tools.wait('exit-plan', controller.signal).then((seen) => {
    assert.equal(seen, true)
    order.push('确认计划')
  })
  tools.observe('tool-search')
  await Promise.resolve()
  assert.equal(order.length, 0)
  order.push('计划正文')
  tools.observe('exit-plan')
  await ready
  assert.deepEqual(order, ['计划正文', '确认计划'])
  assert.equal(await tools.wait('exit-plan', controller.signal), true)
})

test('取消或回合结束释放所有等候，不放行计划确认', async () => {
  const tools = new ToolObservation()
  const controller = new AbortController()
  const cancelled = tools.wait('a', controller.signal)
  controller.abort()
  assert.equal(await cancelled, false)
  const signal = new AbortController().signal
  const waiting = [tools.wait('a', signal), tools.wait('a', signal), tools.wait('b', signal)]
  tools.close()
  assert.deepEqual(await Promise.all(waiting), [false, false, false])
  tools.observe('late')
  assert.equal(await tools.wait('late', signal), false)
})
