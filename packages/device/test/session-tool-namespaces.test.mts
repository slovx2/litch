// 会话对象上的 litchToolNamespaces（sessionTree 扩展）：设备进程记着建会话时带的动态工具，
// 客户端据此知道会话里的模型能不能用 litch_sessions 读别的会话（输入框里 @ 会话时用）。上游是假引擎。
import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import { ECHO_SPEC, litch, plain, SESSIONS, treeRig } from './tree-kit.mjs'

test('SESSION-TOOLS-NS-001：建会话带的 litch_ 命名空间挂在会话对象上；没带工具的、没声明 sessionTree 的连接上没有', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const other = await plain(env)
    const withTools = await client.call('thread/start', {
      harness: 'pi',
      cwd: '/work/app',
      dynamicTools: [ECHO_SPEC, sessionTools(true)],
    })
    const id = withTools.thread.id as string
    // 建会话的应答里就有（记工具在挂字段之前）
    assert.deepEqual(withTools.thread.litchToolNamespaces, ['litch_echo', SESSIONS])
    const bare = await client.call('thread/start', { harness: 'pi', cwd: '/work/app' })
    assert.equal(bare.thread.litchToolNamespaces, undefined)
    const listed = await client.call('thread/list', {})
    assert.deepEqual(listed.data.find((row: any) => row.id === id).litchToolNamespaces, [
      'litch_echo',
      SESSIONS,
    ])
    assert.equal(
      listed.data.find((row: any) => row.id === bare.thread.id).litchToolNamespaces,
      undefined,
    )
    const read = await client.call('thread/read', { threadId: id })
    assert.deepEqual(read.thread.litchToolNamespaces, ['litch_echo', SESSIONS])
    // 没声明 sessionTree 的连接看不到
    const plainList = await other.call('thread/list', {})
    assert.ok(plainList.data.every((row: any) => row.litchToolNamespaces === undefined))
    const plainRead = await other.call('thread/read', { threadId: id })
    assert.equal(plainRead.thread.litchToolNamespaces, undefined)
  } finally {
    await env.close()
  }
})
