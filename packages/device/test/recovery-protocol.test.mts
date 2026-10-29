import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RECOVERY_CHANGED,
  RECOVERY_CONTINUE,
  RECOVERY_READ,
} from '../../protocol/src/turn-recovery.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { assertRuntimeInfo, rig, settle } from './helpers.mjs'

test('恢复方法与通知、运行CLI字段按投递连接声明隔离', async () => {
  const cli = {
    path: '/isolated/bin/pi',
    version: '0.99.1',
    source: 'path' as const,
    startedAt: 1000,
  }
  const control = new FakeControl([{ ...managed('pi'), cli }])
  const pi = new FakeUpstream('pi')
  const instance = rig({ pi }, {}, { control })
  try {
    const aware = instance.connect(),
      plain = instance.connect()
    await aware.initialize(['harness', 'turnRecovery', 'harnessRuntime'])
    await plain.initialize(['harness'])
    assert.deepEqual(await aware.call(RECOVERY_READ, {}), { notices: [] })
    for (const method of [RECOVERY_READ, RECOVERY_CONTINUE])
      await assert.rejects(
        plain.call(method, {}),
        (error: any) => error.data?.litch === 'extensionRequired',
      )
    await assert.rejects(
      plain.call(RECOVERY_CONTINUE, { harness: 'pi', threadId: 't', turnId: 'a', text: '继续' }),
      (error: any) => error.data?.litch === 'extensionRequired',
    )
    assert.equal(
      pi.seen.some((call) => call.method === 'turn/start' || call.method === 'turn/interrupt'),
      false,
    )
    const notice = {
      harness: 'codex',
      threadId: 't',
      turnId: 'a',
      recovery: { reason: 'wake', observedAt: 1, lastProgressAt: 0 },
    }
    // 直接走设备的统一广播口，只验证按实际接收者过滤，不通过客户端身份猜测。
    ;(instance.device as any).announce(RECOVERY_CHANGED, notice, 'turnRecovery')
    await settle()
    assert.equal(aware.notifications.filter((n) => n.method === RECOVERY_CHANGED).length, 1)
    assert.equal(plain.notifications.filter((n) => n.method === RECOVERY_CHANGED).length, 0)
    assertRuntimeInfo(await plain.call('runtime/info', {}))
    const withCLI = await aware.call('runtime/info', {})
    assertRuntimeInfo(withCLI)
    assert.deepEqual(withCLI.harnesses[0].cli, cli)
    assert.equal(Object.hasOwn((await plain.call('runtime/info', {})).harnesses[0], 'cli'), false)
  } finally {
    await instance.close()
  }
})
