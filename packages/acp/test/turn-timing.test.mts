import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import { createJsonlLog, type JsonlLog } from '../../shared/src/log-file.mjs'
import { AcpConnection } from '../src/connection.mjs'
import { AcpServer } from '../src/server.mjs'
import { TurnTiming } from '../src/turn-timing.mjs'
import { client, isolate, text } from './client.mjs'

function fixture() {
  const rows: any[] = []
  let at = 0
  const log: JsonlLog = {
    path: '',
    flush() {},
    write: (event, fields) => rows.push({ event, ...fields }),
  }
  const timing = new TurnTiming(
    log,
    { harness: 'agy', threadId: 'thread', turnId: 'turn' },
    () => at,
  )
  return {
    rows,
    timing,
    set: (value: number) => {
      at = value
    },
  }
}

test('分段时钟：忽略回放/空块、首次内容去重、工具并发及缺失开始不造耗时', () => {
  const { rows, timing, set } = fixture()
  const thought = {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: '秘密思考' },
  }
  timing.update(thought)
  set(10)
  const prompt = timing.prompt(2)
  prompt.sent(4)
  timing.update({ ...thought, content: { type: 'text', text: '' } })
  set(50)
  timing.update(thought)
  timing.update(thought)
  set(100)
  timing.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'a',
    title: '秘密命令',
    rawInput: '秘密参数',
  })
  set(150)
  timing.update({ sessionUpdate: 'tool_call', toolCallId: 'b' })
  set(200)
  timing.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'a',
    status: 'completed',
    rawOutput: '秘密结果',
  })
  set(250)
  timing.update({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed' })
  timing.update({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed' })
  set(300)
  timing.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
  timing.update({ sessionUpdate: 'tool_call', toolCallId: 'unfinished' })
  set(400)
  timing.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '秘密正文' },
  })
  prompt.ended('ok')
  timing.update({ sessionUpdate: 'tool_call', toolCallId: 'after-prompt' })
  timing.finish('completed')
  timing.finish('completed')
  timing.update(thought)
  assert.deepEqual(
    rows.filter((r) => r.event === 'acp.first_thought').map((r) => r.promptMs),
    [40],
  )
  assert.equal(rows.find((r) => r.event === 'acp.first_text').promptMs, 390)
  assert.deepEqual(
    rows.filter((r) => r.event === 'acp.tool.ended').map((r) => r.durationMs),
    [100, 100, null],
  )
  assert.equal(rows.filter((r) => r.event === 'acp.tool.started').length, 3)
  assert.equal(rows.filter((r) => r.event === 'acp.tool.unfinished').length, 1)
  assert.equal(rows.filter((r) => r.event === 'acp.turn.ended').length, 1)
  assert.ok(!JSON.stringify(rows).includes('秘密'))
})

test('实际入口默认日志路径：LITCH_LOG_DIR 写 rpc.jsonl 且不传给 agent', async () => {
  const isolated = await isolate()
  const directory = join(isolated.root, 'logs', 'acp')
  try {
    const source = `
      import assert from 'node:assert/strict'
      import { AcpServer } from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)}
      import { client, text } from ${JSON.stringify(new URL('./client.mjs', import.meta.url).href)}
      assert.equal(process.env.LITCH_LOG_DIR, undefined)
      const server = new AcpServer(${JSON.stringify(isolated.home)})
      const desktop = client(server)
      try {
        await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
        const { thread } = await desktop.call('thread/start', { cwd: ${JSON.stringify(isolated.cwd)} })
        const { turn } = await desktop.call('turn/start', { threadId: thread.id, input: text('hello') })
        await desktop.until('turn/completed', p => p.turn.id === turn.id)
      } finally { await server.close() }
    `
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...isolated.env, LITCH_LOG_DIR: directory },
      timeout: 20000,
    })
    const rows = (await readFile(join(directory, 'rpc.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(rows.some((row) => row.event === 'acp.prompt.sent'))
    assert.ok(rows.some((row) => row.event === 'acp.first_thought'))
    assert.equal(rows.at(-1).event, 'acp.turn.ended')
  } finally {
    await isolated.restore()
  }
})

test('attach 或 flush 失败有回合终态，不伪造 prompt 或首块', async () => {
  for (const phase of ['attach', 'flush'] as const) {
    const isolated = await isolate()
    const rows: any[] = []
    const server = new AcpServer(isolated.home, isolated.env, {
      path: '',
      flush() {},
      write: (event, fields) => {
        rows.push({ event, ...fields })
      },
    })
    const desktop = client(server)
    try {
      await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
      const { thread } = await desktop.call('thread/start', { cwd: isolated.cwd })
      server[phase] = async () => {
        throw new Error('秘密失败原因')
      }
      const { turn } = await desktop.call('turn/start', {
        threadId: thread.id,
        input: text('秘密输入'),
      })
      await desktop.until('turn/completed', (p) => p.turn.id === turn.id)
      assert.equal(rows.at(-1).event, 'acp.turn.ended')
      assert.equal(rows.at(-1).outcome, 'failed')
      assert.ok(rows.some((row) => row.event === `acp.${phase}.started`))
      assert.ok(
        !rows.some((row) => row.event === 'acp.prompt.sent' || row.event === 'acp.first_text'),
      )
      assert.ok(!JSON.stringify(rows).includes('秘密'))
    } finally {
      await server.close()
      await isolated.restore()
    }
  }
})

test('传输边界：同批通知早于 prompt 应答，反向请求记录实际回复；断连只结束一次', async () => {
  const { rows, timing, set } = fixture()
  const input = new PassThrough()
  const output = new PassThrough()
  let release!: (value: unknown) => void
  const connection = new AcpConnection(input, output, {
    request: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    notification: (_method, params) => timing.update(params.update),
    requestTiming: (id, method) => timing.request(id, method),
  })
  set(10)
  const prompt = connection.request('session/prompt', {}, undefined, timing.prompt(1))
  set(50)
  input.write(
    `${JSON.stringify({ id: 'tool', method: 'terminal/create', params: { command: '秘密' } })}\n`,
  )
  set(80)
  release({ output: '秘密' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  set(100)
  input.write(
    `${[
      {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '秘密' } },
        },
      },
      { id: 1, result: { stopReason: 'end_turn' } },
    ]
      .map((message) => JSON.stringify(message))
      .join('\n')}\n`,
  )
  await prompt
  assert.deepEqual(
    rows.map((r) => r.event),
    [
      'acp.turn.started',
      'acp.prompt.sent',
      'acp.request.started',
      'acp.request.ended',
      'acp.first_text',
      'acp.prompt.ended',
    ],
  )
  assert.equal(rows.find((r) => r.event === 'acp.request.ended').durationMs, 30)
  assert.equal(rows.find((r) => r.event === 'acp.first_text').promptMs, 90)
  const second = connection.request('session/prompt', {}, undefined, timing.prompt(1))
  input.write('{"id":"pending","method":"terminal/wait_for_exit"}\n')
  connection.close(new Error('秘密错误'))
  connection.close(new Error('重复关闭'))
  await assert.rejects(second)
  release({})
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    rows.filter((r) => r.event === 'acp.prompt.ended' && r.outcome === 'closed').length,
    1,
  )
  assert.equal(
    rows.filter((r) => r.event === 'acp.request.ended' && r.requestId === 'pending').length,
    1,
  )
  assert.ok(!JSON.stringify(rows).includes('秘密'))
})

test('错误、超时及本地停止后迟到的 prompt 应答不丢失也不冒充成功', async () => {
  for (const mode of ['error', 'timeout', 'late'] as const) {
    const { rows, timing } = fixture()
    const input = new PassThrough()
    const connection = new AcpConnection(input, new PassThrough(), {
      request: async () => ({}),
      notification() {},
    })
    const response = connection.request(
      'session/prompt',
      {},
      mode === 'timeout' ? 1 : undefined,
      timing.prompt(1),
    )
    if (mode === 'error') input.write('{"id":1,"error":{"code":-32603,"message":"秘密"}}\n')
    if (mode === 'late') {
      timing.finish('interrupted')
      input.write('{"id":1,"result":{}}\n')
      await response
    } else await assert.rejects(response)
    assert.equal(rows.filter((r) => r.event === 'acp.prompt.ended').length, 1)
    assert.equal(rows.at(-1).outcome, mode === 'late' ? 'ok' : mode)
    connection.close(new Error('结束'))
  }
})

test('假 agy 端到端：attach/flush、两会话与多回合、审批和终端耗时写入设备 rpc 日志', async () => {
  const isolated = await isolate()
  const path = join(isolated.root, 'logs', 'agy', 'rpc.jsonl')
  const server = new AcpServer(
    isolated.home,
    {
      ...isolated.env,
      CHA_ACP_AGENT: 'agy',
      CHA_AGY_CLI: isolated.env.CHA_ACP_CLI,
      CHA_AGY_ARGS: isolated.env.CHA_ACP_ARGS,
    },
    createJsonlLog(path, { source: 'agy' }),
  )
  const desktop = client(server)
  try {
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    desktop.onRequest(() => ({ decision: 'accept' }))
    const first = (await desktop.call('thread/start', { cwd: isolated.cwd })).thread.id
    const second = (await desktop.call('thread/start', { cwd: isolated.cwd })).thread.id
    const turns = await Promise.all(
      [first, second].map(async (threadId) => {
        const { turn } = await desktop.call('turn/start', { threadId, input: text('hello') })
        await desktop.until('turn/completed', (p) => p.turn.id === turn.id)
        return turn.id
      }),
    )
    // 强制走 session/load：旧正文的回放不能抢占下一回合的首次正文时间。
    const live = server.live.get(first)
    const agent = server.runtime.current()
    assert.ok(live && agent)
    live.generation = 0
    agent.caps.resume = false
    const { turn } = await desktop.call('turn/start', { threadId: first, input: text('run') })
    await desktop.until('turn/completed', (p) => p.turn.id === turn.id)
    turns.push(turn.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const content = await readFile(path, 'utf8')
    const rows = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const turnId of turns) {
      const events = rows.filter((r) => r.turnId === turnId)
      assert.deepEqual(
        events.slice(0, 6).map((r) => r.event),
        [
          'acp.turn.started',
          'acp.attach.started',
          'acp.attach.ended',
          'acp.flush.started',
          'acp.flush.ended',
          'acp.prompt.sent',
        ],
      )
      assert.equal(events.filter((r) => r.event === 'acp.prompt.ended').length, 1)
      assert.equal(events.filter((r) => r.event === 'acp.first_text').length, 1)
      assert.equal(events.at(-1).event, 'acp.turn.ended')
      assert.ok(events.every((r) => r.harness === 'agy' && r.ts && r.elapsedMs >= 0))
    }
    const tools = rows.filter((r) => r.event === 'acp.tool.ended')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].toolCallId, 'call-run')
    assert.ok(tools[0].durationMs >= 0)
    assert.ok(
      rows.some((r) => r.event === 'acp.request.ended' && r.method === 'terminal/wait_for_exit'),
    )
    assert.ok(
      rows.some(
        (r) => r.event === 'acp.request.ended' && r.method === 'session/request_permission',
      ),
    )
    assert.ok(
      !content.includes('echo hi') && !content.includes('你好') && !content.includes('想一想'),
    )
  } finally {
    await server.close()
    await isolated.restore()
  }
})
