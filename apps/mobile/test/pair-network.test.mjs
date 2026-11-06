import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodePairPayload,
  encodePairPayload,
} from '../../../packages/protocol/src/device-pairing.mts'
import { canResumePairing, pairNetworkPrompt } from '../src/platform/pair-network.ts'

const payload = {
  v: 1,
  n: '测试设备',
  h: 'server.lan',
  p: 22,
  u: 'dev',
  k: { t: 'ssh-ed25519', f: 'SHA256:test' },
  s: 'A'.repeat(43),
  i: 'test-pair',
  e: 1_900_000_000_000,
}
const connected = {
  state: 'connected',
  hostname: 'phone',
  tailnet: 'example.com',
  authURL: '',
  controlURL: '',
  hosts: ['build', 'build.test.ts.net', '100.100.10.20'],
}

test('二维码标识、Tailscale SSH 和旧码的地址特征取并集', () => {
  for (const code of [
    { ...payload, ts: 1 },
    { ...payload, m: 'tailscale', c: 'adapter pair-enroll test-pair', s: undefined },
    ...[
      '100.64.0.0',
      '100.127.255.255',
      'fd7a:115c:a1e0::1',
      '[FD7A:115C:A1E0::AB]',
      'fd7a:115c:a1e0:0:0:0:0:1',
      'node.TEST.ts.net.',
    ].map((h) => ({ ...payload, h })),
  ]) {
    const decoded = decodePairPayload(encodePairPayload(code))
    assert.ok(decoded)
    assert.equal(pairNetworkPrompt(decoded, null), 'login', code.h)
    assert.equal(pairNetworkPrompt(decoded, connected), 'account', code.h)
    assert.equal(pairNetworkPrompt(decoded, { ...connected, state: 'needsLogin' }), 'login')
  }
})

test('普通地址不提示，节点表短名只在当前节点表命中时提示', () => {
  for (const h of [
    '192.168.1.2',
    '100.63.255.255',
    '100.128.0.0',
    '100.64.999.1',
    'fd7a:115c:a1e1::1',
    'fd7a:115c:a1e0:::1',
    'fd7a:115c:a1e0:1:',
    'fd7a:115c:a1e0::z',
    'host.ts.net.evil.test',
    'localhost',
    'build',
  ]) {
    assert.equal(pairNetworkPrompt({ ...payload, h }, null), null, h)
  }
  assert.equal(pairNetworkPrompt({ ...payload, h: 'BUILD.' }, connected), 'account')
  assert.equal(pairNetworkPrompt({ ...payload, h: 'build' }, { ...connected, hosts: [] }), null)
})

test('新旧二维码双向兼容：可选标识独立于已有字段，未知键仍忽略', () => {
  const old = decodePairPayload(encodePairPayload(payload))
  assert.deepEqual(old, payload)
  const newer = { ...payload, ts: 1, a: 1 }
  assert.deepEqual(decodePairPayload(encodePairPayload(newer)), newer)
  const raw = Buffer.from(JSON.stringify({ ...newer, future: true })).toString('base64url')
  assert.deepEqual(decodePairPayload(`LITCHPAIR1:${raw}`), newer)
  // 旧版解码器忽略未知键：去掉新增字段后仍是完全相同的可绑定载荷。
  const { ts: _hint, ...legacyFields } = decodePairPayload(encodePairPayload(newer))
  assert.deepEqual(legacyFields, { ...payload, a: 1 })
})

test('只有完成登录且网络已连接才续配，返回或取消不能误用旧账号', () => {
  assert.equal(canResumePairing(connected, true), true)
  assert.equal(canResumePairing(connected, false), false)
  assert.equal(canResumePairing(null, true), false)
  for (const state of ['needsApproval', 'needsLogin', 'starting', 'stopped', 'suspended'])
    assert.equal(canResumePairing({ ...connected, state }, true), false)
})
