// 正式 core → 通道 → 手机 SessionStore/RowBuilder；对端明确发送 queued→held，不能用 mock-core 代替。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectChannel, createPortPair, serveChannel } from '@litch/core'
import { files } from 'expo-file-system'
import { userText } from '../../../packages/core/test/fixtures.mts'
import { finished, runtimeInfo, setup, where } from '../../../packages/core/test/world.mts'
import { SessionStore } from '../src/core/session-store.ts'
import { fileDeviceStore } from '../src/platform/device-store.ts'
import { until } from './helpers.mjs'

test('手机正式对话行：queued→held 从气泡移到托盘，重发后只留新气泡', async () => {
  const env = setup(
    undefined,
    {
      'runtime/info': () =>
        runtimeInfo({
          engine: 'claude-code',
          extensions: ['inputDelivery'],
          features: { steer: true },
        }),
      'turn/steer': (params) => ({ turnId: params.expectedTurnId }),
    },
    fileDeviceStore(),
  )
  const clock = {
    now: Date.now,
    setTimer(callback, delay) {
      const id = setTimeout(callback, delay)
      return () => clearTimeout(id)
    },
  }
  const [ui, server] = createPortPair()
  const unserve = serveChannel(server, env.core, { clock })
  const channel = connectChannel(ui)
  const store = new SessionStore(channel, where.deviceId, where.sessionId)
  env.core.start()
  store.start()
  const users = () => store.getSnapshot().rows.filter((row) => row.type === 'user')
  try {
    await until(() => store.getMeta()?.live)
    await channel.command('session.send', { ...where, text: '阻塞工具' })
    await channel.command('session.send', { ...where, text: '手机待发', now: true })
    const sent = env.sent('turn/steer')[0]
    const item = {
      ...userText('cancelled-native', '手机待发'),
      clientId: sent.clientUserMessageId,
      litchInputDelivery: 'queued',
    }
    env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'srv-1', item })
    await until(() => users().length === 2)
    await channel.command('session.interrupt', where)
    env.peer.last().notify('turn/completed', {
      threadId: 'a',
      turn: finished('srv-1', { status: 'interrupted' }),
    })
    env.peer.last().notify('item/completed', {
      threadId: 'a',
      turnId: 'srv-1',
      item: { ...item, litchInputDelivery: 'held' },
    })
    await until(() => store.getMeta()?.queued[0]?.delivery === 'held' && users().length === 1)
    assert.equal(store.getMeta().queued[0].text, '手机待发')
    await channel.command('session.resumeQueue', where)
    await until(() => env.sent('turn/start').length === 2)
    const attempt = env.sent('turn/start')[1]
    env.peer.last().notify('item/completed', {
      threadId: 'a',
      turnId: 'srv-2',
      item: { ...userText('new-native', '手机待发'), clientId: attempt.clientUserMessageId },
    })
    await until(() => users().length === 2 && store.getMeta().queued.length === 0)
    assert.equal(
      Object.values(store.currentView().items).filter(
        (entry) => entry.kind === 'userMessage' && entry.text === '手机待发',
      ).length,
      1,
    )
  } finally {
    store.stop()
    channel.close()
    unserve()
    env.core.stop()
    files.clear()
  }
})
