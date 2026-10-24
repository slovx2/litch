// 未读（packages/ui/src/app/read.ts、src/core/store-cache.ts）接在模拟核心上：进会话清掉、开着时回合结束不标、
// 离开后回合结束重新标；离开时还留着的会话存储不能让核心以为还有人在看；子会话和父会话各记各的。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createReplica, keys } from '@litch/core'
import { readWhileOpen } from '../../../packages/ui/src/app/read.ts'
import { acquireStore, releaseStore } from '../src/core/store-cache.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0).reverse()) done()
})

async function setup() {
  const mock = mockChannel()
  const replica = createReplica(mock.channel)
  const stop = replica.start()
  cleanup.push(() => {
    stop()
    mock.close()
  })
  await until(() => replica.store.get(keys.summary('local', 's3')), { what: '侧栏' })
  const summary = (id) => replica.store.get(keys.summary('local', id))
  const send = (sessionId, text) =>
    mock.channel.command('session.send', { deviceId: 'local', sessionId, text, now: Date.now() })
  /** 等它跑起来再停下来（模拟的回合只有几十毫秒，轮询会错过“在跑”，所以盯着摘要） */
  const turn = async (sessionId, text) => {
    let ran = false
    let ended = false
    const stopWatch = replica.store.subscribe(keys.summary('local', sessionId), () => {
      const status = summary(sessionId)?.status
      if (status !== 'idle') ran = true
      else if (ran) ended = true
    })
    await send(sessionId, text)
    await until(() => ended, { timeoutMs: 8000, what: `${sessionId} 回合结束` })
    stopWatch()
  }
  return { mock, replica, summary, send, turn }
}

/** 照详情页：会话存储加 readWhileOpen，返回“退回列表” */
function enter({ mock, replica }, sessionId) {
  const store = acquireStore(mock.channel, 'local', sessionId)
  const stopRead = readWhileOpen(mock.channel, replica.store, 'local', sessionId)
  let left = false
  const leave = () => {
    if (left) return
    left = true
    stopRead()
    releaseStore(store)
  }
  cleanup.push(leave)
  return { store, leave }
}

test('进会话就清掉未读，退回列表也不再出；开着时回合结束不标', async () => {
  const env = await setup()
  assert.equal(env.summary('s3').unread, true, '示例数据里 s3 未读')
  const { leave } = enter(env, 's3')
  await until(() => env.summary('s3').unread === false, { what: '未读清掉' })
  await env.turn('s3', '开着说一句')
  assert.equal(env.summary('s3').unread, false, '开着时结束不标')
  leave()
  assert.equal(env.summary('s3').unread, false)
})

test('离开以后回合才结束：重新标未读，再进来又清掉', async () => {
  const env = await setup()
  const first = enter(env, 's3')
  await until(() => env.summary('s3').unread === false, { what: '未读清掉' })
  first.leave()
  // 离开时会话存储还留着（store-cache），可它不能算“有人在看”
  await env.turn('s3', '离开后说一句')
  assert.equal(env.summary('s3').unread, true, '离开后的新内容要标未读')
  enter(env, 's3')
  await until(() => env.summary('s3').unread === false, { what: '再进来清掉' })
})

test('会话存储缓存：在跑时离开当场关、留着的开始跑了也关', async () => {
  const env = await setup()
  // 在跑时离开
  const running = enter(env, 's3')
  await env.send('s3', '跑一会儿')
  await until(() => running.store.runningNow(), { what: '存储收到在跑' })
  running.leave()
  // 再拿是新的一个；它收到快照时会话还在跑，离开后也马上关
  const fresh = acquireStore(env.mock.channel, 'local', 's3')
  assert.notEqual(fresh, running.store, '在跑时离开就关')
  releaseStore(fresh)
  await until(() => env.summary('s3').unread, { timeoutMs: 8000, what: '回合结束标未读' })
  // 闲着时离开留着；别处让它跑起来了就关
  const idle = enter(env, 's7')
  await until(() => env.summary('s7').unread === false, { what: 's7 清掉' })
  await until(() => idle.store.getSnapshot().rows.length > 0, { what: 's7 的行' })
  idle.leave()
  const kept = acquireStore(env.mock.channel, 'local', 's7')
  assert.equal(kept, idle.store, '闲着离开的留着')
  releaseStore(kept)
  await env.turn('s7', '别处说一句，跑一会儿')
  assert.equal(env.summary('s7').unread, true, '留着的存储没挡住未读')
  const after = acquireStore(env.mock.channel, 'local', 's7')
  assert.notEqual(after, idle.store, '跑起来时就关了')
  releaseStore(after)
})

test('会话树：子会话、父会话的未读各记各的', async () => {
  const env = await setup()
  const { sessionId: child } = await env.mock.channel.command('session.spawn', {
    deviceId: 'local',
    parentId: 's3',
    kind: 'fresh',
    title: '子会话',
    prompt: '子会话',
    wakeParent: false,
  })
  // 没人看着的子会话跑完标未读
  await until(() => env.summary(child)?.unread, { what: '子会话跑完标未读' })
  assert.equal(env.summary(child).status, 'idle')
  assert.equal(env.summary(child).lineage?.parentId, 's3')
  // 进父会话只清父会话
  const parent = enter(env, 's3')
  await until(() => env.summary('s3').unread === false, { what: '父会话清掉' })
  assert.equal(env.summary(child).unread, true, '子会话不跟着清')
  parent.leave()
  // 进子会话只清子会话
  await env.turn('s3', '父会话再说一句')
  enter(env, child)
  await until(() => env.summary(child).unread === false, { what: '子会话清掉' })
  assert.equal(env.summary('s3').unread, true, '父会话不跟着清')
})
