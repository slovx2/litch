import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BootstrapFrame, outputConfig } from '../../src/bootstrap.mjs'
import { LocalHarness, type WireEvent } from '../../src/runtime.mjs'

test('stdio 分帧、认证 WS、完整流式回合与进程清理', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-wire-'))
  const events: WireEvent[] = []
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const runtime = new LocalHarness({
    executable: process.execPath,
    args: [fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))],
    home,
    config: { cascadeId: 'test' },
    event(event) {
      events.push(event)
      if (event.trajectoryStateUpdate?.state === 'STATE_FULLY_IDLE') resolveDone()
    },
    failed(error) {
      throw error
    },
    timeoutMs: 2000,
  })
  try {
    assert.equal((await runtime.start()).cascadeId, 'test')
    runtime.send({ userInput: { parts: [{ text: 'hello' }] } })
    await done
    assert.deepEqual(
      events.filter((event) => event.stepUpdate).map((event) => event.stepUpdate.textDelta),
      ['mock', ' answer'],
    )
  } finally {
    await runtime.close()
    await rm(home, { recursive: true, force: true })
  }
})
test('拒绝错误引导帧、缺失字段和未知字段', () => {
  assert.throws(() => new BootstrapFrame().push(Buffer.from([255, 255, 255, 255])))
  assert.throws(() => outputConfig(Buffer.from([8, 0])))
  assert.throws(() => outputConfig(Buffer.from([42, 1, 2])))
})
test('启动失败与超时不会留下悬挂等待', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-failed-'))
  try {
    for (const args of [
      ['-e', 'setInterval(()=>{},100)'],
      ['-e', 'process.exit(1)'],
    ]) {
      const runtime = new LocalHarness({
        executable: process.execPath,
        args,
        home,
        config: {},
        event() {},
        failed() {},
        timeoutMs: 60,
      })
      await assert.rejects(runtime.start(), /超时|退出/)
      await runtime.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
