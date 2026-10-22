// 核心的摘要（trace.mts）：对设备的请求、设备发来的请求、界面命令。只记方法、标识、成败、耗时、错误原文
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ChannelError,
  type CoreHost,
  connectChannel,
  createPortPair,
  createRpc,
  createTransportPair,
  serveChannel,
  traceParams,
} from '../src/index.mjs'
import { RpcFailure, serveFake } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

type Record_ = { event: string; level: string | undefined } & Record<string, unknown>

function recorder() {
  const records: Record_[] = []
  return {
    records,
    trace: (event: string, fields: Record<string, unknown>, level?: string) =>
      records.push({ event, level, ...fields }),
  }
}

test('对设备的请求：成败、耗时、标识字段、错误原文；超时记下原因；正文不记', async () => {
  const time = fakeClock()
  const [client, server] = createTransportPair()
  const fake = serveFake(server, {
    'thread/read': (params) => ({ thread: { id: (params as { threadId: string }).threadId } }),
    'turn/start': () => {
      throw new RpcFailure(-32602, '会话不存在')
    },
    hang: () => undefined,
  })
  const { records, trace } = recorder()
  const pending: { answer?: (value: unknown) => void } = {}
  const rpc = createRpc(client, {
    clock: time.clock,
    notification: () => {},
    close: () => {},
    request: () =>
      new Promise((resolve) => {
        pending.answer = resolve
      }),
    trace,
  })
  await rpc.request('thread/read', { threadId: 't1' })
  await assert.rejects(
    rpc.request('turn/start', { threadId: 't1', input: [{ type: 'text', text: '用户的话' }] }),
  )
  const slow = rpc.request('hang', {}, { timeoutMs: 50 })
  await settle()
  time.advance(50)
  await assert.rejects(slow)
  // 设备发来的请求（审批）：答了以后记一条
  const asked = fake.ask('item/commandExecution/requestApproval', { threadId: 't1', turnId: 'u1' })
  await settle()
  time.advance(1200)
  pending.answer?.({ decision: 'accept' })
  await asked
  await settle()
  assert.doesNotMatch(JSON.stringify(records), /用户的话/)
  assert.deepEqual(
    records.map(({ ms: _ms, id: _id, ...rest }) => rest),
    [
      { event: 'rpc', level: 'info', method: 'thread/read', threadId: 't1', ok: true },
      {
        event: 'rpc',
        level: 'warn',
        method: 'turn/start',
        threadId: 't1',
        ok: false,
        error: '会话不存在',
      },
      {
        event: 'rpc',
        level: 'warn',
        method: 'hang',
        ok: false,
        error: 'hang 在 50 毫秒内未响应',
        aborted: 'timeout',
      },
      {
        event: 'serverRequest',
        level: 'info',
        method: 'item/commandExecution/requestApproval',
        threadId: 't1',
        turnId: 'u1',
        ok: true,
      },
    ],
  )
  assert.equal(records[3]?.ms, 1200)
})

test('界面命令：名字、标识字段、成败、错误码；终端按键这类太密的不记', async () => {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  const host: CoreHost = {
    async command(name) {
      if (name === 'session.proposal.dismiss') throw new ChannelError('notFound', '提案没了')
      return {}
    },
    subscribe: () => () => {},
  }
  const { records, trace } = recorder()
  serveChannel(corePort, host, { clock: time.clock, trace })
  const channel = connectChannel(uiPort)
  await channel.command('device.reconnect', { deviceId: 'd1' })
  await assert.rejects(
    channel.command('session.proposal.dismiss', {
      deviceId: 'd1',
      sessionId: 's1',
      proposalId: 'p1',
    }),
  )
  await channel.command('terminal.write', { deviceId: 'd1', terminalId: 'x', data: 'ls\r' })
  await settle()
  assert.deepEqual(
    records.map(({ ms: _ms, ...rest }) => rest),
    [
      { event: 'command', level: 'info', command: 'device.reconnect', deviceId: 'd1', ok: true },
      {
        event: 'command',
        level: 'warn',
        command: 'session.proposal.dismiss',
        deviceId: 'd1',
        sessionId: 's1',
        proposalId: 'p1',
        ok: false,
        code: 'notFound',
        error: '提案没了',
      },
    ],
  )
})

test('参数字段：第一层的标识（以 Id 结尾、harness）和设置（模型、强度、权限、工作目录），正文不记', () => {
  assert.deepEqual(
    traceParams({
      deviceId: 'd',
      harness: 'pi',
      text: '正文',
      path: '/a/b',
      threadId: 't'.repeat(150),
      nested: { turnId: 'u' },
      hid: 'not an id',
      model: 'gpt-5.5',
      effort: 'low',
      cwd: '/work',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', note: '正文' },
      collaborationMode: { mode: 'default', settings: { developer_instructions: '正文' } },
      input: [{ type: 'text', text: '正文' }],
    }),
    {
      deviceId: 'd',
      harness: 'pi',
      threadId: 't'.repeat(100),
      model: 'gpt-5.5',
      effort: 'low',
      cwd: '/work',
      approvalPolicy: 'never',
      sandboxPolicy: 'readOnly',
      collaborationMode: 'default',
    },
  )
})
