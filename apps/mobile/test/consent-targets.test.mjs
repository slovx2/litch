import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReplica, keys } from '@litch/core'
import { consentTargets } from '../src/privacy/targets.ts'
import { mockChannel, until } from './helpers.mjs'

test('真实模拟核心：会话当前型号和新会话供应商配置可在发送前读取', async () => {
  const mock = mockChannel()
  const replica = createReplica(mock.channel)
  const stop = replica.start()
  try {
    await until(() => replica.store.get(keys.device('local')))
    const resolve = consentTargets(
      mock.channel,
      replica,
      () => 'en',
      () => 'unavailable',
    )
    const existing = await resolve('session.send', { deviceId: 'local', sessionId: 's2' })
    assert.equal(existing.length, 1)
    assert.equal(existing[0].harness, 'claude')
    assert.ok(existing[0].label)
    const fresh = await resolve('session.create', {
      deviceId: 'local',
      harness: 'pi',
      cwd: null,
      settings: { model: 'lab/qwen3-coder-480b' },
    })
    assert.equal(fresh[0].provider, 'lab')
    assert.equal(fresh[0].model, 'lab/qwen3-coder-480b')
    assert.match(fresh[0].label, /10\.0\.3\.40/)
    assert.equal(fresh[0].remember, true)
    const attachment = await resolve('files.uploadAttachment', { deviceId: 'local' })
    assert.equal(attachment[0].provider, 'attachment-upload')
    assert.equal(attachment[0].remember, false)
    replica.store.set(keys.managerIds('local'), ['test-manager'])
    replica.store.set(keys.manager('local', 'test-manager'), {
      id: 'test-manager',
      threadId: 's2',
      harness: 'claude',
      model: 'old-provider/model',
      cwd: '/tmp/project',
      dispatch: { harness: 'pi', model: 'lab/qwen3-coder-480b' },
    })
    const changed = await resolve('session.configure', {
      deviceId: 'local',
      sessionId: 's2',
      settings: { model: 'new-provider/model' },
    })
    assert.equal(changed[0].model, 'new-provider/model')
    assert.equal(changed[0].delegated, true)
    assert.equal(changed[1].provider, 'lab')
  } finally {
    stop()
    mock.close()
  }
})
