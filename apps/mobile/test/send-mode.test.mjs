// 回合进行中发消息（src/detail/composer/send-mode.ts）：默认立即发送、prefs.json 里认不得的按默认，
// 插不了话的会话照桌面退回排队；接在模拟核心上看两种设置下回合中发的那条是插进去了还是排着。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { SessionStore } from '../src/core/session-store.ts'
import { sendFlags, sendModeOf, whenRunning } from '../src/detail/composer/send-mode.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

test('设置：默认立即发送，存着的认得就用，认不得的按默认', () => {
  assert.equal(sendModeOf(undefined), 'now')
  assert.equal(sendModeOf(null), 'now')
  assert.equal(sendModeOf('queue'), 'queue')
  assert.equal(sendModeOf('now'), 'now')
  assert.equal(sendModeOf('steer'), 'now')
  assert.equal(sendModeOf(1), 'now')
})

test('回合进行中按下发送：插得了话才带 now，选了排队或插不了话的都排队', () => {
  assert.equal(whenRunning('now', { steer: true }), 'steer')
  assert.equal(whenRunning('now', undefined), 'steer', '会话还没到先当插得了')
  assert.equal(whenRunning('now', { steer: false }), 'fallback')
  assert.equal(whenRunning('queue', { steer: true }), 'queue')
  assert.deepEqual(sendFlags('steer'), { now: true })
  assert.deepEqual(sendFlags('fallback'), {})
  assert.deepEqual(sendFlags('queue'), {})
})

/** 开一个回答流得慢的会话，等到回合在跑 */
async function running() {
  const mock = mockChannel({ chunkMs: 40 })
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '长回答',
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  store.start()
  await until(() => store.getMeta()?.running, { what: '回合在跑' })
  const send = (mode, text) =>
    mock.channel.command('session.send', {
      deviceId: 'local',
      sessionId,
      text,
      images: [],
      extras: [],
      ...sendFlags(whenRunning(mode, store.getMeta().can)),
    })
  return { store, send }
}

const said = (store) =>
  store
    .getSnapshot()
    .rows.filter((row) => row.type === 'user')
    .map((row) => row.text)

test('立即发送：回合中发的那条插进正在跑的回合，不排队', async () => {
  const { store, send } = await running()
  await send('now', '顺便看下测试')
  await until(() => said(store).includes('顺便看下测试'), { what: '插进去的那条' })
  assert.deepEqual(store.getMeta().queued, [])
  const turns = store.getSnapshot().rows.filter((row) => row.type === 'status')
  assert.equal(turns.length, 1, '还是原来那个回合，没另开一轮')
})

test('排队：回合中发的那条排着，不进对话', async () => {
  const { store, send } = await running()
  await send('queue', '等会儿再说')
  await until(() => store.getMeta().queued.length === 1, { what: '排着的那条' })
  assert.equal(store.getMeta().queued[0].text, '等会儿再说')
  assert.ok(!said(store).includes('等会儿再说'))
})
