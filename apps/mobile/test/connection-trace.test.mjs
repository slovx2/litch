import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionTrace } from '../src/platform/connection-trace.ts'

test('只记录连接枚举与进程内设备短编号，不记录 RPC、地址或错误正文', () => {
  const lines = []
  const trace = connectionTrace(
    (line) => lines.push(JSON.parse(line)),
    () => 123,
  )
  const secret = 'private-host.example/secret-key/session-body'
  trace('rpc.result', { device: secret, method: 'runtime/info', text: secret })
  trace('link', { device: secret, phase: 'connecting', error: secret, server: secret })
  trace('harness.state', {
    device: secret,
    harness: 'codex',
    state: 'unavailable',
    reason: 'notInstalled',
    detail: secret,
  })
  trace('connection', { device: secret, state: 'online' })
  trace('catalog', { device: 'second-private-device', phase: 'end', result: 'ok', elapsedMs: 52.4 })
  assert.equal(lines.length, 4)
  assert.deepEqual(lines[0], { time: 123, device: 'd1', event: 'link', state: 'connecting' })
  assert.equal(lines[1].reason, 'notInstalled')
  assert.equal(lines[2].device, 'd1')
  assert.equal(lines[3].device, 'd2')
  assert.equal(lines[3].elapsedMs, 52)
  assert.doesNotMatch(JSON.stringify(lines), /private|secret|session-body/)
})

test('远端自定义 harness、未知故障及非法状态不泄漏，写日志失败不打断连接', () => {
  const lines = []
  const trace = connectionTrace((line) => lines.push(JSON.parse(line)))
  trace('harness.state', {
    device: 'private',
    harness: 'private-provider',
    state: 'unavailable',
    reason: 'private-error',
  })
  trace('link', { device: 'private', phase: 'private-error' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].harness, 'other')
  assert.equal(lines[0].reason, null)
  const broken = connectionTrace(() => {
    throw new Error('日志写入失败')
  })
  assert.doesNotThrow(() => broken('link', { device: 'private', phase: 'connected' }))
})
