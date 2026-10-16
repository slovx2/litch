import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyNotificationOptOut,
  optOutNotificationMethods,
} from '../../shared/src/notification-opt-out.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import type { PermissionDecision } from '../src/types.mjs'
import { type Connection, openStage } from './fixtures/in-process.mjs'

// 握手里的 capabilities.optOutNotificationMethods（上游协议里就有）：客户端退订的通知，这条连接上不发。
// 头两条守着三个入口共用的那个函数（packages/shared/src/notification-opt-out.mts），
// 后两条守着 Claude Code 的入口照它做了。Pi、dsh 的入口各有自己的一条。

const text = (value: string) => [{ type: 'text', text: value }]
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const COMMAND = 'item/commandExecution/requestApproval'
const opting = (...methods: unknown[]) => ({ capabilities: { optOutNotificationMethods: methods } })

function recorder(): { peer: RpcPeer; sent: WireMessage[] } {
  const sent: WireMessage[] = []
  return { sent, peer: { id: 'recorder', close() {}, send: (message) => void sent.push(message) } }
}

test('OPTOUT-001：名单从握手参数里读；没带、是 null、不是数组都当作没退订，数组里不是字符串的不算', () => {
  const read = (params: unknown) => [...optOutNotificationMethods(params)]
  assert.deepEqual(read(opting('thread/started', 'warning')), ['thread/started', 'warning'])
  assert.deepEqual(read(opting('thread/started', 7, null, { method: 'warning' })), [
    'thread/started',
  ])
  for (const absent of [
    undefined,
    null,
    {},
    { capabilities: null },
    { capabilities: {} },
    { capabilities: { optOutNotificationMethods: null } },
    { capabilities: { optOutNotificationMethods: 'thread/started' } },
  ])
    assert.deepEqual(read(absent), [], JSON.stringify(absent))
})

test('OPTOUT-002：只拦名单上的通知，方法名精确匹配；应答、错误、服务端请求照发；再握手只换名单', () => {
  const { peer, sent } = recorder()
  applyNotificationOptOut(peer, opting('thread/started', 'item', 'item/tool/call'))
  const started: WireMessage = { method: 'thread/started', params: { thread: { id: 't' } } }
  const itemStarted: WireMessage = { method: 'item/started', params: { threadId: 't' } }
  // 名单上的方法名，但带着 id：这是服务端发起的请求，不是通知
  const toolCall: WireMessage = { jsonrpc: '2.0', id: 'call-1', method: 'item/tool/call' }
  const result: WireMessage = { jsonrpc: '2.0', id: 1, result: {} }
  const failure: WireMessage = { jsonrpc: '2.0', id: 2, error: { code: -32601, message: '没有' } }
  // 只是前缀相同、或者多一截的不算
  const longer: WireMessage = { method: 'thread/started/later', params: {} }
  for (const message of [started, itemStarted, toolCall, result, failure, longer])
    peer.send(message)
  assert.deepEqual(sent, [itemStarted, toolCall, result, failure, longer])

  // 同一条连接再握手：名单整个换掉，过滤不叠两层（放行的消息只出去一次）
  sent.length = 0
  applyNotificationOptOut(peer, opting('item/started'))
  for (const message of [started, itemStarted, result]) peer.send(message)
  assert.deepEqual(sent, [started, result])

  sent.length = 0
  applyNotificationOptOut(peer, { capabilities: null })
  for (const message of [started, itemStarted]) peer.send(message)
  assert.deepEqual(sent, [started, itemStarted])
})

const threadMethods = (connection: Connection, threadId: string, from: number): string[] =>
  [
    ...new Set(
      connection.trace
        .slice(from)
        .filter((message) => message.method && message.id === undefined)
        .filter((message) => message.params?.threadId === threadId)
        .map((message) => message.method as string),
    ),
  ].sort()

test('OPTOUT-003：Claude Code 的入口：退订的通知这条连接收不到，同一个会话的别的连接照收；名单上的服务端请求照发、照答', async () => {
  const stage = await openStage('opt-out-turn')
  try {
    const optedOut = [
      'account/updated',
      'thread/started',
      'item/agentMessage/delta',
      'thread/tokenUsage/updated',
      COMMAND,
    ]
    const loud = await stage.connect('loud')
    const quiet = await stage.connect('quiet', { optOutNotificationMethods: optedOut })
    // 握手之后排着推的账号通知也算
    assert.equal(loud.notifications('account/updated').length, 1)
    assert.equal(quiet.notifications('account/updated').length, 0)

    const { thread } = await quiet.request('thread/start', { cwd: stage.directory })
    const other = await loud.request('thread/start', { cwd: stage.directory })
    await loud.notification('thread/started', (params) => params.thread.id === other.thread.id)
    await loud.request('thread/resume', { threadId: thread.id })
    await settle()
    assert.equal(quiet.notifications('thread/started').length, 0)

    const decisions: PermissionDecision[] = []
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({ type: 'text_delta', delta: '先说一句' })
      const call = { toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'echo hi' } }
      await handlers.onEvent({ type: 'tool_use', ...call })
      decisions.push(
        await handlers.onPermissionRequest({
          type: 'permission_request',
          requestId: 'perm-1',
          ...call,
        }),
      )
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: call.toolUseId,
        content: 'hi\n',
        isError: false,
      })
      await handlers.onEvent({ type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } })
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    }
    const mark = { loud: loud.trace.length, quiet: quiet.trace.length }
    const { turn } = await quiet.request('turn/start', {
      threadId: thread.id,
      input: text('跑一条命令'),
    })
    // 审批的方法名在名单上，但它是请求：照样送到，退订了的这条连接来答也算数
    const request = await quiet.serverRequest(COMMAND)
    await loud.serverRequest(COMMAND)
    await quiet.answer(request, { decision: 'accept' })
    assert.equal((await quiet.completed(turn.id)).status, 'completed')
    assert.equal((await loud.completed(turn.id)).status, 'completed')
    await settle()
    assert.deepEqual(
      decisions.map((decision) => decision.decision),
      ['accept'],
    )

    const heard = threadMethods(loud, thread.id, mark.loud)
    for (const method of ['item/agentMessage/delta', 'thread/tokenUsage/updated', 'item/started'])
      assert.ok(heard.includes(method), `没退订的连接应当收到 ${method}：${heard.join(', ')}`)
    // 除了名单上的，一条不少
    assert.deepEqual(
      threadMethods(quiet, thread.id, mark.quiet),
      heard.filter((method) => !optedOut.includes(method)),
    )
  } finally {
    await stage.dispose()
  }
})

test('OPTOUT-004：Claude Code 的入口：共用层发的通知（终端的输出）也按名单拦，没退订的那种照发', async () => {
  const stage = await openStage('opt-out-process')
  try {
    const spawn = (connection: Connection, handle: string) =>
      connection.request('process/spawn', {
        processHandle: handle,
        cwd: stage.directory,
        command: ['/bin/sh', '-c', 'printf opted'],
        streamStdoutStderr: true,
      })
    const loud = await stage.connect('loud')
    const quiet = await stage.connect('quiet', {
      optOutNotificationMethods: ['process/outputDelta'],
    })
    await spawn(loud, 'loud-process')
    await spawn(quiet, 'quiet-process')
    await loud.notification('process/exited')
    await quiet.notification('process/exited')
    assert.ok(loud.notifications('process/outputDelta').length > 0)
    assert.equal(quiet.notifications('process/outputDelta').length, 0)
  } finally {
    await stage.dispose()
  }
})
