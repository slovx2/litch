import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore } from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

test('账号命令经真实核心路由到指定设备与 harness；只透传方法标识，错误不当作成功', async () => {
  const fake = fakeDevice([
    harness('agy', { declaration: { extensions: ['acpControls'] } }),
    harness('pi'),
  ])
  let status = 'signedOut'
  let rejectLogin = false
  const peer = fakeOpener({
    ...fake.handlers,
    'litch/acp/auth/read': () => ({
      methods: [{ id: 'oauth-personal', name: 'Google', type: 'agent', description: null }],
      logout: true,
      instruction: 'agy acp --login',
      status,
    }),
    'litch/acp/auth/authenticate': () => {
      if (rejectLogin) throw new RpcFailure(-32603, 'login failed')
      status = 'signedIn'
      return {}
    },
    'litch/acp/auth/logout': () => {
      status = 'signedOut'
      return {}
    },
  })
  const core = createCore({
    clock: fakeClock().clock,
    version: '0',
    log: () => {},
    devices: [
      {
        id: 'dev',
        name: 'test',
        host: 'test',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const call = (method: string, extra = {}) =>
    core.command(method, { deviceId: 'dev', harness: 'agy', ...extra }, never)
  core.start()
  try {
    for (let i = 0; i < 5; i++) await settle()
    const init = peer.last().seen.find((r) => r.method === 'initialize')?.params as any
    assert.ok(init.capabilities.litchExtensions.includes('acpControls'))
    assert.equal(((await call('acp.auth.read')) as any).status, 'signedOut')
    assert.equal(
      peer.last().seen.some((r) => r.method === 'litch/acp/auth/authenticate'),
      false,
    )
    await call('acp.auth.authenticate', { methodId: 'oauth-personal', token: 'do-not-forward' })
    assert.equal(((await call('acp.auth.read')) as any).status, 'signedIn')
    assert.deepEqual(
      peer.last().seen.find((r) => r.method === 'litch/acp/auth/authenticate')?.params,
      { harness: 'agy', methodId: 'oauth-personal' },
    )
    await call('acp.auth.logout')
    assert.equal(((await call('acp.auth.read')) as any).status, 'signedOut')
    rejectLogin = true
    await assert.rejects(call('acp.auth.authenticate', { methodId: 'oauth-personal' }))
    await assert.rejects(call('acp.auth.read', { harness: 'pi' }), { code: 'unsupported' })
  } finally {
    core.stop()
  }
})
