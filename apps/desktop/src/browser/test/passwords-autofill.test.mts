// 自动填充在主进程里的判断（broker.mts）：只认人手里的标签（代理自己在用的不给、交给人登录的给）、
// 只按框架的真实源、非 https 不填、点选时框架跳走了或交还给代理了不填、密码只送给发起的那一个框架。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAutofillBroker, type FillMessage, type FrameRef } from '../passwords/broker.mjs'
import type { PasswordCandidate } from '../passwords/store.mjs'

const SAVED: Record<string, Array<PasswordCandidate & { password: string }>> = {
  'https://bank.example': [
    { id: 'p1', username: 'ann', password: 'bank-secret' },
    { id: 'p2', username: 'bob', password: 'bob-secret' },
  ],
  'https://sso.example': [{ id: 'p3', username: 'ann', password: 'sso-secret' }],
  'http://localhost:4000': [{ id: 'p4', username: 'dev', password: 'dev-secret' }],
  'http://plain.example': [{ id: 'p5', username: 'old', password: 'plain-secret' }],
}

function setup() {
  // 1 是用户的标签，2 是代理的标签，别的没登记过
  const kinds = new Map<number, 'user' | 'agent'>([
    [1, 'user'],
    [2, 'agent'],
  ])
  const revealed: string[] = []
  const broker = createAutofillBroker({
    kindOf: (id) => kinds.get(id) ?? null,
    store: {
      candidates: (origin) => (SAVED[origin] ?? []).map(({ id, username }) => ({ id, username })),
      reveal(id, origin) {
        const hit = (SAVED[origin] ?? []).find((one) => one.id === id)
        if (!hit) return null
        revealed.push(id)
        return { username: hit.username, password: hit.password }
      },
    },
  })
  return { broker, revealed, kinds }
}

let frames = 0
function frame(contentsId: number, origin: string) {
  const sent: FillMessage[] = []
  const state = { origin, alive: true }
  const ref: FrameRef = {
    contentsId,
    key: `${contentsId}:f${++frames}`,
    origin: () => state.origin,
    alive: () => state.alive,
    send: (message) => void sent.push(message),
  }
  return { ref, sent, state }
}

test('用户标签按框架的真实源拿候选，只有用户名', () => {
  const { broker } = setup()
  const offer = broker.offerFor(frame(1, 'https://bank.example').ref)
  assert.deepEqual(offer?.usernames, ['ann', 'bob'])
  assert.equal(JSON.stringify(offer).includes('secret'), false)
})

test('伪造的源拿不到候选：只看主进程从框架取的源', () => {
  const { broker } = setup()
  // 预加载的消息里不带源；页面是 evil 的，就算它在网页里写着 bank 也只按 evil 找
  assert.equal(broker.offerFor(frame(1, 'https://evil.example').ref), null)
  // 跨源子框架按它自己的源：bank 页面里嵌的 sso 子框架拿的是 sso 的
  assert.deepEqual(broker.offerFor(frame(1, 'https://sso.example').ref)?.usernames, ['ann'])
  // 不透明的源（沙箱 iframe、data:）不填
  assert.equal(broker.offerFor(frame(1, 'null').ref), null)
})

test('没登记过的标签没有候选、不填', () => {
  const { broker, revealed } = setup()
  const stranger = frame(9, 'https://bank.example')
  assert.equal(broker.offerFor(stranger.ref), null)
  const offer = broker.offerFor(frame(1, 'https://bank.example').ref)
  assert.ok(offer)
  // 拿别的标签的候选去它里面填也不行
  assert.equal(broker.fill(stranger.ref, offer, 0), false)
  assert.deepEqual(stranger.sent, [])
  assert.deepEqual(revealed, [])
})

test('代理自己在用的标签没有候选、不填；交给人登录时有，交还之后点选也不填', () => {
  const { broker, revealed, kinds } = setup()
  const agent = frame(2, 'https://bank.example')
  assert.equal(broker.offerFor(agent.ref), null)
  // 交给人登录：按用户的标签对待（tabs.mts 的 autofillKind）
  kinds.set(2, 'user')
  const offer = broker.offerFor(agent.ref)
  assert.deepEqual(offer?.usernames, ['ann', 'bob'])
  assert.ok(offer)
  // 菜单开着的时候交还给代理了：不填
  kinds.set(2, 'agent')
  assert.equal(broker.fill(agent.ref, offer, 0), false)
  assert.deepEqual(agent.sent, [])
  assert.deepEqual(revealed, [])
  kinds.set(2, 'user')
  assert.equal(broker.fill(agent.ref, offer, 0), true)
  assert.deepEqual(agent.sent, [{ username: 'ann', password: 'bank-secret' }])
})

test('非 https 不填，本机回环的 http 除外', () => {
  const { broker } = setup()
  assert.equal(broker.offerFor(frame(1, 'http://plain.example').ref), null)
  assert.deepEqual(broker.offerFor(frame(1, 'http://localhost:4000').ref)?.usernames, ['dev'])
})

test('点选之后才解开那一条，只送给发起的框架', () => {
  const { broker, revealed } = setup()
  const bank = frame(1, 'https://bank.example')
  const other = frame(1, 'https://bank.example')
  const offer = broker.offerFor(bank.ref)
  assert.ok(offer)
  assert.deepEqual(revealed, [])
  assert.equal(broker.fill(bank.ref, offer, 1), true)
  assert.deepEqual(bank.sent, [{ username: 'bob', password: 'bob-secret' }])
  assert.deepEqual(other.sent, [])
  assert.deepEqual(revealed, ['p2'])
  assert.equal(broker.fill(bank.ref, offer, 9), false)
})

test('菜单开着时框架跳走了、没了：不填', () => {
  const { broker, revealed } = setup()
  const bank = frame(1, 'https://bank.example')
  const offer = broker.offerFor(bank.ref)
  assert.ok(offer)
  bank.state.origin = 'https://evil.example'
  assert.equal(broker.fill(bank.ref, offer, 0), false)
  bank.state.origin = 'https://bank.example'
  bank.state.alive = false
  assert.equal(broker.fill(bank.ref, offer, 0), false)
  assert.deepEqual(bank.sent, [])
  assert.deepEqual(revealed, [])
})
