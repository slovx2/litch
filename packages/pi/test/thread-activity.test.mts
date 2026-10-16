import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'
import { approvalHarness, pause } from './approval-harness.mjs'

// 会话的最后活动时间（updatedAt）照上游（rust-v0.162.0-alpha.20）：是会话记录最后写入的时间，
// 回合里写下的东西（TurnStarted、TurnComplete 这些事件）都算（thread-store 的
// live_thread_output_advances_updated_at_but_not_recency_at）。所以一个回合跑完了，哪怕没说出一句话，
// 会话也有了动静；只是打开看一眼不算（Pi 的计划插件在会话打开、关闭时往文件里记自己的状态，那不是新内容）。
// 真实 Pi SDK、随适配器分发的计划插件，加回环上的假模型。

type Ok = (method: string, params?: any) => Promise<any>

/** 原生会话文件里的条目 */
const nativeEntries = (path: string): any[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

/** 列会话、读会话里这个会话的最后活动 */
async function stamps(ok: Ok, threadId: string) {
  const listed = (await ok('thread/list', {})).data.find((t: any) => t.id === threadId)
  const read = (await ok('thread/read', { threadId })).thread
  return { list: listed?.updatedAt, read: read.updatedAt }
}

/** 同一个状态目录上重新起一个入口（模拟重启），用完自己关 */
async function reopen(root: string) {
  const server = new PiServer(join(root, 'state'))
  const got: any[] = []
  const peer: RpcPeer = {
    id: 'after-restart',
    close() {},
    send: (message: WireMessage) => void got.push(message),
  }
  let sequence = 0
  const ok: Ok = async (method, params = {}) => {
    const id = ++sequence
    await server.handle(peer, { jsonrpc: '2.0', id, method, params })
    const reply = got.find((m) => m.id === id && !m.method)
    assert.equal(reply?.error, undefined, `${method}: ${JSON.stringify(reply?.error)}`)
    return reply.result
  }
  await ok('initialize')
  return { server, ok }
}

test('ACTIVITY-PI-001：只走插件命令的回合（/plan 打开菜单、跳过）也算会话有了动静；列会话、读会话、重启之后都一样，打开看一眼不算', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    // 官方桌面端：握手时不声明扩展
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    assert.equal((await c.completed(await c.start(threadId, '第一句'))).status, 'completed')
    const before = await stamps(c.ok, threadId)
    assert.equal(before.list, before.read)
    // 时间按秒算：隔开两秒，前一个回合和这个回合的时间才分得开
    await pause(2100)
    const path = String(h.server.store.thread(threadId).path)
    const messages = () => nativeEntries(path).filter((e) => e.type === 'message').length
    const written = messages()
    const asked = h.requests.length
    const from = Math.floor(Date.now() / 1000)
    // 官方桌面端发来的 /plan 结尾带一个换行；插件弹菜单，用户跳过（不选、不填）
    const turnId = await c.start(threadId, '/plan\n')
    const menu = await c.until(
      '/plan 的菜单',
      (m) => m.method === 'item/tool/requestUserInput' && m.params.threadId === threadId,
    )
    await c.answer(menu, { answers: { [menu.params.questions[0].id]: { answers: [] } } })
    assert.equal((await c.completed(turnId)).status, 'completed')
    const to = Math.floor(Date.now() / 1000)
    // 前提：这个回合没请求模型，也没往原生会话文件里写消息
    assert.equal(h.requests.length, asked, '插件命令的回合请求了模型')
    assert.equal(messages(), written, '插件命令的回合往原生会话里写了消息')
    const after = await stamps(c.ok, threadId)
    assert.equal(after.list, after.read)
    assert.ok(
      after.read >= from && after.read <= to,
      `最后活动应是这个回合结束的时候（${from}..${to}），实际 ${after.read}，回合之前是 ${before.read}`,
    )

    // 重启之后各会话从原生会话文件重新扫出来，还是这个时间
    await h.shutdown()
    const { server, ok } = await reopen(h.root)
    try {
      assert.deepEqual(await stamps(ok, threadId), after, '重启之后')
      // 打开看一眼不算：恢复、退订，会话释放时计划插件往文件里记一条自己的状态
      await pause(1100)
      const lines = nativeEntries(path).length
      await ok('thread/resume', { threadId })
      await ok('thread/unsubscribe', { threadId })
      await server.releaseUnused()
      assert.ok(nativeEntries(path).length > lines, '前提：打开、关闭会话时插件往文件里记了状态')
      assert.deepEqual(await stamps(ok, threadId), after, '打开看了一眼之后')
    } finally {
      await server.close()
    }
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

test('ACTIVITY-PI-002：压缩上下文的回合不写消息，同样算会话有了动静；重启之后一样', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({
    approvals: false,
    // 一轮说完就有东西可压
    prepare: async (agentDir) => {
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'gate',
          defaultModel: 'gate',
          retry: { enabled: false },
          compaction: { keepRecentTokens: 0 },
        }),
      )
    },
  })
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    assert.equal((await c.completed(await c.start(threadId, '头一轮'))).status, 'completed')
    const before = await stamps(c.ok, threadId)
    await pause(2100)
    const path = String(h.server.store.thread(threadId).path)
    const messages = () => nativeEntries(path).filter((e) => e.type === 'message').length
    const written = messages()
    const from = Math.floor(Date.now() / 1000)
    const sent = c.messages.length
    assert.deepEqual(await c.ok('thread/compact/start', { threadId }), {})
    const started = await c.until(
      '压缩的回合开始',
      (m) => m.method === 'turn/started' && c.messages.indexOf(m) >= sent,
    )
    assert.equal((await c.completed(started.params.turn.id)).status, 'completed')
    const to = Math.floor(Date.now() / 1000)
    assert.equal(messages(), written, '压缩的回合往原生会话里写了消息')
    const after = await stamps(c.ok, threadId)
    assert.equal(after.list, after.read)
    assert.ok(
      after.read >= from && after.read <= to,
      `最后活动应是压缩结束的时候（${from}..${to}），实际 ${after.read}，压缩之前是 ${before.read}`,
    )
    await h.shutdown()
    const { server, ok } = await reopen(h.root)
    try {
      assert.deepEqual(await stamps(ok, threadId), after, '重启之后')
    } finally {
      await server.close()
    }
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})
