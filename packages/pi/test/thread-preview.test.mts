import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'
import { approvalHarness } from './approval-harness.mjs'

// 会话的预览（头一句话）和会话列表照上游（rust-v0.162.0-alpha.20）：
// - 上游记下第一条用户消息就落盘（state 库的 preview 列），第一个回合进行中 thread/read、thread/list 里就有；
//   这时它不另发通知（预览变了没有对应的通知），客户端靠回合和条目的通知、再读一次会话看到
// - thread/list 不列没说过话、预览为空的会话（state/src/runtime/threads.rs：`preview <> ''`）；
//   列已归档的、按上级找子会话、按某个分组找时照列。官方桌面端在新对话页上会先建一个空会话，没用就删
// - Pi 入口按“有预览或者有过回合”认说过话：头一句只有图片（或只有技能）时预览是空的，这样的会话照列
// 真实 Pi SDK、回环上的假模型。

// 1×1 的 PNG
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const ids = (listed: any) => listed.data.map((thread: any) => thread.id).sort()

test('PREVIEW-PI-001：第一个回合进行中，读会话、列会话里就有第一句话', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    const c = await h.connect('litch')
    const other = await h.connect('other')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    // 模型一直不答，等用例放行：回合停在进行中
    let release = () => {}
    h.steps.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ text: '好' })
        }),
    )
    const turnId = await c.start(threadId, '第一句话')
    await c.until('请求了模型', () => h.requests.length > 0)
    for (const who of [c, other]) {
      assert.equal((await who.ok('thread/read', { threadId })).thread.preview, '第一句话')
      const listed = (await who.ok('thread/list', {})).data
      assert.deepEqual(
        listed.map((thread: any) => [thread.id, thread.preview]),
        [[threadId, '第一句话']],
        `${who.peer.id} 列出的会话`,
      )
    }
    release()
    assert.equal((await c.completed(turnId)).status, 'completed')
    assert.equal((await other.ok('thread/read', { threadId })).thread.preview, '第一句话')
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

test('LIST-PI-001：没说过话的会话不列，归档的照列；头一句只发了图片的照列，重启之后一样', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    const c = await h.connect('desktop')
    const start = async () =>
      (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id as string
    const empty = await start()
    const spoken = await start()
    await c.completed(await c.start(spoken, '说过话'))
    const pictured = await start()
    const sent = await c.ok('turn/start', {
      threadId: pictured,
      input: [{ type: 'image', url: `data:image/png;base64,${PIXEL}` }],
    })
    await c.completed(sent.turn.id)
    const listed = await c.ok('thread/list', {})
    assert.deepEqual(ids(listed), [spoken, pictured].sort(), '没说过话的会话不该列出来')
    assert.equal(listed.data.find((thread: any) => thread.id === pictured).preview, '')
    // 读得到，只是不列
    assert.equal((await c.ok('thread/read', { threadId: empty })).thread.preview, '')
    // 归档的照列（上游列已归档的时不按预览滤）
    await c.ok('thread/archive', { threadId: empty })
    assert.deepEqual(ids(await c.ok('thread/list', { archived: true })), [empty])

    // 重启之后照原生会话文件重新算预览和回合，一样
    await h.shutdown()
    const server = new PiServer(join(h.root, 'state'))
    try {
      const messages: any[] = []
      const peer: RpcPeer = {
        id: 'after-restart',
        close() {},
        send: (message: WireMessage) => void messages.push(message),
      }
      const call = async (id: number, method: string, params: any = {}) => {
        await server.handle(peer, { jsonrpc: '2.0', id, method, params })
        const reply = messages.find((m) => m.id === id && !m.method)
        assert.equal(reply?.error, undefined, `${method}: ${JSON.stringify(reply?.error)}`)
        return reply.result
      }
      await call(1, 'initialize')
      const again = await call(2, 'thread/list', {})
      assert.deepEqual(
        again.data.map((thread: any) => [thread.id, thread.preview]).sort(),
        [
          [pictured, ''],
          [spoken, '说过话'],
        ].sort(),
      )
    } finally {
      await server.close()
    }
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})
