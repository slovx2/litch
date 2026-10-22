// 设备侧的日志：共用的 JSONL 写入（轮转、按时长和个数清理）、入口的协议请求摘要、设备进程的请求摘要、
// 日志目录的取走（测试隔离）
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  createJsonlLog,
  errorText,
  idFields,
  type LogLimits,
  pruneLogs,
  resetTakenLogDir,
  takeLogDir,
} from '../../shared/src/log-file.mjs'
import { createRpcTrace } from '../../shared/src/rpc-log.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig, settle, tempDir } from './helpers.mjs'

const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

test('JSONL 日志：到了上限换新文件，每个来源最多留 keep 个，字段齐全', () => {
  const directory = tempDir()
  const path = join(directory, 'logs', 'rpc.jsonl')
  let clock = Date.UTC(2026, 9, 22, 10, 0, 0)
  const limits: LogLimits = { maxBytes: 300, keep: 3, maxAgeMs: 0 }
  const log = createJsonlLog(path, { source: 'pi', limits, now: () => clock })
  for (let round = 0; round < 12; round += 1) {
    log.write('rpc', { method: 'thread/list', ok: true, ms: round })
    log.flush()
    clock += 1000
  }
  const files = readdirSync(join(directory, 'logs')).sort()
  assert.deepEqual(files, ['rpc.jsonl', 'rpc.jsonl.1', 'rpc.jsonl.2'])
  const entry = lines(path).at(-1)
  assert.equal(entry?.src, 'pi')
  assert.equal(entry?.event, 'rpc')
  assert.equal(entry?.level, 'info')
  assert.equal(entry?.pid, process.pid)
  assert.equal(entry?.ms, 11)
  assert.equal(entry?.ts, new Date(clock - 1000).toISOString())
  // 最新的在正在写的文件里，次新的在 .1：按时间接得上
  const older = lines(`${path}.1`).at(-1)?.ms as number
  assert.ok(older < (lines(path)[0]?.ms as number))
})

test('按时长清理：最后一次写入超过期限的旧文件删掉，太久没写的正在写的文件也删', () => {
  const directory = tempDir()
  const path = join(directory, 'debug.jsonl')
  const now = Date.UTC(2026, 9, 22, 12, 0, 0)
  const write = (name: string, ageDays: number) => {
    const file = join(directory, name)
    writeFileSync(file, '{}\n')
    const at = new Date(now - ageDays * 24 * 3600 * 1000)
    utimesSync(file, at, at)
  }
  write('debug.jsonl', 8)
  write('debug.jsonl.1', 1)
  write('debug.jsonl.2', 9)
  write('debug.jsonl.9', 0)
  write('other.jsonl.1', 30)
  pruneLogs(path, { maxBytes: 1024, keep: 5, maxAgeMs: 7 * 24 * 3600 * 1000 }, now)
  // 不是这个来源的不动
  assert.deepEqual(readdirSync(directory).sort(), ['debug.jsonl.1', 'other.jsonl.1'])
})

test('参数只挑标识字段，错误原文截短', () => {
  assert.deepEqual(
    idFields({
      threadId: 't1',
      turnId: 7,
      harness: 'pi',
      input: [{ type: 'text', text: '用户的话' }],
      cwd: '/secret/project',
      apiKey: 'sk-1',
      providerId: 'x'.repeat(300),
    }),
    { threadId: 't1', turnId: 7, harness: 'pi', providerId: 'x'.repeat(100) },
  )
  assert.deepEqual(idFields(['threadId']), {})
  assert.equal(errorText({ code: 1, message: 'm' }), 'm')
  assert.equal(errorText(new Error('e'.repeat(600))).length, 501)
})

test('日志目录：取走以后环境里就没有了，再起的进程看不到', () => {
  resetTakenLogDir()
  const env: NodeJS.ProcessEnv = { LITCH_LOG_DIR: '/state/logs/pi', OTHER: '1' }
  assert.equal(takeLogDir(env), '/state/logs/pi')
  assert.deepEqual(env, { OTHER: '1' })
  // 同一个进程里第二次拿到的还是第一次的
  assert.equal(takeLogDir({}), '/state/logs/pi')
  resetTakenLogDir()
  assert.equal(takeLogDir({}), null)
  resetTakenLogDir()
})

test('入口的协议请求摘要：请求配上应答记成败和耗时，服务端请求配上答复，通知不记', () => {
  const directory = tempDir()
  const path = join(directory, 'rpc.jsonl')
  let clock = 1000
  const log = createJsonlLog(path, {
    source: 'pi',
    limits: { maxBytes: 0, keep: 5, maxAgeMs: 0 },
    now: () => clock,
  })
  const trace = createRpcTrace(log, () => clock)
  const peer: RpcPeer = { id: 'abcdef0123456789', send() {}, close() {} }
  trace.opened(peer)
  trace.received(peer, {
    jsonrpc: '2.0',
    id: 1,
    method: 'turn/start',
    params: { threadId: 't1', input: [{ type: 'text', text: '不该进日志的正文' }] },
  })
  trace.received(peer, { jsonrpc: '2.0', id: 2, method: 'thread/read', params: {} })
  trace.sent(peer, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: '正文' } })
  clock += 25
  trace.sent(peer, { jsonrpc: '2.0', id: 1, result: { turn: { id: 'u1' } } })
  trace.sent(peer, { jsonrpc: '2.0', id: 2, error: { code: -32602, message: '未知会话' } })
  trace.sent(peer, {
    jsonrpc: '2.0',
    id: 'srv-1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't1' },
  })
  clock += 5
  trace.received(peer, { jsonrpc: '2.0', id: 'srv-1', result: { decision: 'accept' } })
  trace.received(peer, { jsonrpc: '2.0', id: 3, method: 'thread/list', params: {} })
  trace.closed(peer)
  log.flush()
  const text = readFileSync(path, 'utf8')
  assert.doesNotMatch(text, /正文/)
  assert.deepEqual(
    lines(path).map(({ ts: _ts, pid: _pid, ...rest }) => rest),
    [
      { level: 'info', src: 'pi', event: 'peer.open', peer: 'abcdef01' },
      {
        level: 'info',
        src: 'pi',
        event: 'rpc',
        method: 'turn/start',
        peer: 'abcdef01',
        id: 1,
        threadId: 't1',
        ok: true,
        ms: 25,
      },
      {
        level: 'warn',
        src: 'pi',
        event: 'rpc',
        method: 'thread/read',
        peer: 'abcdef01',
        id: 2,
        ok: false,
        ms: 25,
        error: '未知会话',
      },
      {
        level: 'info',
        src: 'pi',
        event: 'serverRequest',
        method: 'item/commandExecution/requestApproval',
        peer: 'abcdef01',
        id: 'srv-1',
        threadId: 't1',
        ok: true,
        ms: 5,
      },
      { level: 'info', src: 'pi', event: 'peer.close', peer: 'abcdef01', unanswered: 1 },
    ],
  )
})

test('设备进程的请求摘要：转发给上游的、自己答的、失败的都记，带 harness 和标识字段', async () => {
  const pi = new FakeUpstream('pi', [{ id: 'p1', updatedAt: 1, cwd: '/work' }])
  const records: Record<string, unknown>[] = []
  const env = rig({ pi }, {}, { trace: (event, fields) => records.push({ event, ...fields }) })
  try {
    const client = env.connect()
    await client.initialize()
    await client.call('thread/read', { threadId: 'p1' })
    await client.fails('thread/read', { threadId: 'nope', harness: 'pi' })
    await client.call('runtime/info')
    await settle()
    const rpc = records.filter((entry) => entry.event === 'rpc')
    const pick = (method: string) => rpc.filter((entry) => entry.method === method)
    assert.equal(pick('initialize')[0]?.ok, true)
    const [read, missing] = pick('thread/read')
    assert.equal(read?.harness, 'pi')
    assert.equal(read?.threadId, 'p1')
    assert.equal(read?.ok, true)
    assert.equal(typeof read?.ms, 'number')
    assert.equal(missing?.ok, false)
    assert.equal(missing?.error, '未知会话')
    assert.equal(pick('runtime/info')[0]?.ok, true)
    assert.ok(
      records.some((entry) => entry.event === 'peer.ready' && entry.client === 'device-test'),
    )
  } finally {
    await env.close()
  }
  assert.ok(records.some((entry) => entry.event === 'peer.close'))
})
