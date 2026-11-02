// 回合进行中发消息的两档（src/composer/send-mode-logic.ts）：存着的那一份怎么读、默认是立即发送；
// 立即发送插得了话就插、插不了退回排队；排队那一档一律排队；各自配哪一句提示。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { canSend, DEFAULT_SEND_MODE, readSendMode, runningPlaceholder, runningSend, SEND_MODES } =
  await import('../src/composer/send-mode-logic.ts')

test('默认立即发送；存着的读不懂、没有都按默认', () => {
  assert.equal(DEFAULT_SEND_MODE, 'now')
  assert.deepEqual(SEND_MODES, ['now', 'queue'])
  assert.equal(readSendMode(null), 'now')
  assert.equal(readSendMode(''), 'now')
  assert.equal(readSendMode('not json'), 'now')
  assert.equal(readSendMode('null'), 'now')
  assert.equal(readSendMode('{"mode":"later"}'), 'now')
  assert.equal(readSendMode('{"mode":"queue"}'), 'queue')
  assert.equal(readSendMode('{"mode":"now"}'), 'now')
})

test('立即发送：插得了话就插，插不了退回排队并说明', () => {
  assert.equal(runningSend('now', true), 'steer')
  assert.equal(runningSend('now', false), 'fallback')
  assert.equal(runningPlaceholder('steer'), 'composer.placeholderSteer')
  assert.equal(runningPlaceholder('fallback'), 'composer.placeholderNoSteer')
})

test('排队：不管插不插得了话都排队，提示照旧', () => {
  assert.equal(runningSend('queue', true), 'queue')
  assert.equal(runningSend('queue', false), 'queue')
  assert.equal(runningPlaceholder('queue'), 'composer.placeholderRunning')
})

test('上一条还在发时照样能发；新建会话时要等上一条建好，不然会另建一个会话', () => {
  const draft = { filled: true, blocked: false, imagesRefused: false, sending: false, fresh: false }
  assert.equal(canSend(draft), true)
  assert.equal(canSend({ ...draft, sending: true }), true)
  assert.equal(canSend({ ...draft, fresh: true }), true)
  assert.equal(canSend({ ...draft, fresh: true, sending: true }), false)
  // 没写东西、会话发不了、带着收不了的图：在不在发都不能发
  for (const sending of [false, true]) {
    assert.equal(canSend({ ...draft, sending, filled: false }), false)
    assert.equal(canSend({ ...draft, sending, blocked: true }), false)
    assert.equal(canSend({ ...draft, sending, imagesRefused: true }), false)
  }
})
