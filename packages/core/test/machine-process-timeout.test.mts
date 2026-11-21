// 对真实子进程验证 litch_machine 底层的连接型 process/spawn；只拨设备计时，不实际等待一小时。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'

test('正式 process/spawn 到一小时才终止进程并返回 124', { timeout: 15_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const processes = new ProcessRpc((command) => command)
  let onExited: (params: unknown) => void = () => {}
  let onOutput: (params: unknown) => void = () => {}
  const exited = new Promise((resolve) => {
    onExited = resolve
  })
  const echo = new Promise((resolve) => {
    onOutput = resolve
  })
  const peer: RpcPeer = {
    id: 'machine-timeout-fixture',
    close() {},
    send(message) {
      if (!('method' in message)) return
      if (message.method === 'process/outputDelta') onOutput(message.params)
      if (message.method === 'process/exited') onExited(message.params)
    },
  }

  try {
    await processes.start(peer, 'process', {
      processHandle: 'hour',
      command: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      cwd: process.cwd(),
      streamStdin: true,
      streamStdoutStderr: true,
      timeoutMs: 3_600_000,
    })
    t.mock.timers.tick(3_599_999)
    assert.equal(processes.activeCount, 1)
    await processes.followup(peer, 'process', 'write', {
      processHandle: 'hour',
      deltaBase64: 'bGl2ZQ==',
    })
    assert.deepEqual(await echo, {
      processHandle: 'hour',
      stream: 'stdout',
      deltaBase64: 'bGl2ZQ==',
      capReached: false,
    })
    t.mock.timers.tick(1)
    assert.deepEqual(await exited, {
      processHandle: 'hour',
      exitCode: 124,
      stdout: '',
      stderr: '',
      stdoutCapReached: false,
      stderrCapReached: false,
    })
    assert.equal(processes.activeCount, 0)
  } finally {
    t.mock.timers.reset()
    await processes.close()
  }
})
