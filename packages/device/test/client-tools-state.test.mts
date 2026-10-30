// biome-ignore-all lint/complexity/useLiteralKeys: 方括号仅用于单测检查私有状态，不扩大生产接口。
// 常驻设备的路由状态有界；完成索引与跨回合的近期去重记录分开清理。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DeclaredClientTools } from '../../shared/src/client-tool-executor.mjs'
import {
  CLIENT_TOOL_DONE_LIMIT,
  type ClientToolPeer,
  ClientToolRouter,
  type ClientToolSource,
} from '../src/client-tools.mjs'
import type { Frame } from '../src/wire.mjs'
import { settle } from './helpers.mjs'

function fixture() {
  const router = new ClientToolRouter({ graceMs: 0, log() {} })
  const answers = new Map<string, (reply: Frame) => void>()
  const replied: string[] = []
  const source: ClientToolSource = {
    harness: 'codex',
    available: true,
    reply: (raw) => replied.push(raw),
  }
  const peer: ClientToolPeer = {
    id: 'desktop',
    ready: true,
    desktop: null,
    clientToolNamespaces: new DeclaredClientTools(['litch_browser']),
    deliverClientTool(_harness, frame, reply) {
      answers.set(String(frame.id), reply)
      return String(frame.id)
    },
    withdrawClientTool() {},
    upstream: () => null,
  }
  router.join(peer)
  router.subscribed(peer, 'claude-code', 'parent')
  const offer = (id: string, threadId = 'child') => {
    router.offer(
      null,
      source,
      {
        id,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId: `turn-${threadId}`,
          callId: id,
          namespace: 'litch_browser',
          tool: 'snapshot',
          arguments: {},
        },
      },
      id,
    )
  }
  const answer = (id: string) => {
    const reply = answers.get(id)
    assert.ok(reply)
    reply({ id, result: { success: true, contentItems: [] } })
  }
  router.inherit('parent', 'child')
  return { router, source, peer, offer, answer, answers, replied }
}

test('调用成功、撤回、失败都立即清掉 byRequest；重复 resolved 仍被拦截', async () => {
  const env = fixture()
  env.offer('ok')
  env.answer('ok')
  assert.equal(env.router['byRequest'].size, 0)
  assert.equal(env.router.resolved(env.source, 'ok'), true)
  env.offer('resolved')
  assert.equal(env.router.resolved(env.source, 'resolved'), true)
  assert.equal(env.router['byRequest'].size, 0)
  assert.equal(env.router.resolved(env.source, 'resolved'), true)
  env.offer('interrupted')
  env.router.turnEnded('codex', 'turn-child')
  assert.equal(env.router['byRequest'].size, 0)
  env.offer('disconnected')
  env.router.left(env.peer)
  assert.equal(env.router['byRequest'].size, 0)
  env.offer('no-executor')
  await settle()
  assert.equal(env.router['byRequest'].size, 0)
  assert.match(env.replied.at(-1) ?? '', /noExecutor/)
})

test('done 达到总量上限后先进先出；回合结束不会提前清掉近期记录', () => {
  const env = fixture()
  for (let i = 0; i <= CLIENT_TOOL_DONE_LIMIT; i++) {
    env.offer(String(i))
    env.answer(String(i))
  }
  const done = env.router['done']
  assert.equal(done.size, CLIENT_TOOL_DONE_LIMIT)
  assert.equal(done.has('codex\0child\x000'), false)
  assert.equal(done.keys().next().value, 'codex\0child\x001')
  env.router.turnEnded('codex', 'turn-child')
  assert.equal(done.size, CLIENT_TOOL_DONE_LIMIT)
  const delivered = env.answers.size
  env.offer(String(CLIENT_TOOL_DONE_LIMIT))
  assert.equal(env.answers.size, delivered)
  assert.equal(env.router['byRequest'].size, 0)
})

for (const method of [
  'thread/closed',
  'thread/archived',
  'thread/deleted',
  'thread/status/changed',
])
  test(`${method} 清掉该会话三张表，保留其他会话`, () => {
    const env = fixture()
    env.router.inherit('parent', 'other')
    env.offer('old')
    env.answer('old')
    env.offer('pending')
    env.offer('other-done', 'other')
    env.answer('other-done')
    env.offer('other-pending', 'other')
    env.router.threadEvent('codex', method, { threadId: 'child', status: { type: 'notLoaded' } })
    assert.equal(env.router['byRequest'].size, 1)
    assert.equal(
      [...env.router['byRequest'].values()].some((key) => key.includes('\0child\0')),
      false,
    )
    assert.deepEqual([...env.router['done'].keys()], ['codex\0other\0other-done'])
    assert.deepEqual([...env.router['inherited'].keys()], ['other'])
    assert.match(env.replied.at(-1) ?? '', /调用已取消/)
    env.answer('pending')
    assert.equal(env.router['byRequest'].size, 1)
    env.router.threadClosed('codex', 'other')
  })
