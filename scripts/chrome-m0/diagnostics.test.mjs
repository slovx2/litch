import assert from 'node:assert/strict'
import test from 'node:test'
import { Cdp, until } from './cdp.mjs'
import { diagnoseFailure } from './diagnostics.mjs'

test('CDP 超时保留发请求的调用位置和完整表达式', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cdp = new Cdp()
  cdp.ws = { send() {} }
  const params = { expression: 'window.__projectionProbe.actions.requestNewSession()' }
  const failed = assert.rejects(cdp.call('Runtime.evaluate', params), (error) => {
    assert.match(error.stack, /diagnostics\.test\.mjs/)
    assert.equal(error.request.method, 'Runtime.evaluate')
    assert.equal(error.request.params.expression, params.expression)
    return true
  })
  t.mock.timers.tick(15000)
  await failed
  assert.equal(cdp.pending.size, 0)
})

test('轮询到期仍保留最后一个 CDP 错误及其调用位置', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const original = new Error('CDP 超时：Runtime.evaluate')
  await assert.rejects(
    until(
      () => {
        t.mock.timers.tick(11)
        throw original
      },
      '两个投影组',
      10,
    ),
    (error) => {
      assert.match(error.message, /两个投影组/)
      assert.equal(error.cause, original)
      return true
    },
  )
})

test('取现场再次超时也不覆盖首次失败，并在诊断之前先输出首次失败', async () => {
  const report = { phase: '两个投影组', checks: [] }
  const original = new Error('首次投影超时')
  const lines = []
  await diagnoseFailure(
    report,
    original,
    async () => {
      assert.equal(lines.length, 1)
      assert.match(lines[0], /首次投影超时/)
      throw new Error('诊断 Runtime.evaluate 超时')
    },
    (line) => lines.push(line),
  )
  assert.equal(report.failure.stack, original.stack)
  assert.match(report.diagnosticFailure.stack, /诊断 Runtime.evaluate 超时/)
  assert.equal(lines.length, 2)
})
