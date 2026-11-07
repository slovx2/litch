import assert from 'node:assert/strict'
import { test } from 'node:test'
import { features } from './device-world.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { runtimeInfo, setup, watch, where } from './world.mjs'

test('编辑插话只重取被截断回合，保留早期正文；页面应答之前不发送', async () => {
  const older = Array.from({ length: 200 }, (_, i) =>
    turn(`old${i}`, [agentText(`a${i}`, '文'.repeat(10000))]),
  )
  const tail = turn('tail', [
    userText('u', '原消息'),
    agentText('a', '保留回答'),
    userText('s', '插话'),
  ])
  let release!: () => void
  const app = setup([thread({ id: 'a', turns: [...older, tail] })], {
    'runtime/info': () =>
      runtimeInfo({
        features: features({
          revert: { byTurnId: true, byCount: true, restoresFiles: false, byItemId: true },
        }),
      }),
    'thread/revert': () => ({ turnsBackwardsCursor: null }),
    'thread/turns/list': (params) => {
      assert.deepEqual(params, {
        threadId: 'a',
        cursor: null,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'full',
      })
      return new Promise((resolve) => {
        release = () =>
          resolve({
            data: [{ ...tail, items: tail.items.slice(0, 2), itemsView: 'full' }],
            nextCursor: 'old199',
            backwardsCursor: null,
          })
      })
    },
  })
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  const reads = app.sent('thread/resume').length
  const before = session.seen.view?.items['old0:a0']
  const command = app.command('session.edit', {
    ...where,
    turnId: 'tail',
    itemId: 'tail:s',
    text: '改过了',
  })
  await settle()
  assert.equal(app.sent('turn/start').length, 0)
  release()
  await command
  assert.equal(app.sent('thread/resume').length, reads)
  assert.equal(app.sent('turn/start').length, 1)
  assert.equal(session.seen.view?.items['old0:a0'], before)
  assert.equal(session.seen.view?.items['tail:s'], undefined)
  assert.equal(session.seen.view?.items['tail:a']?.kind, 'agentMessage')
  session.close()
  app.core.stop()
})
