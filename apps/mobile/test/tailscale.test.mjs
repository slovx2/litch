import assert from 'node:assert/strict'
import { test } from 'node:test'
import { natives } from 'expo-modules-core'
import { ssh } from '../modules/litch-ssh/src/index.ts'
import { sshFailure } from '../src/platform/ssh-errors.ts'
import {
  controlURL,
  tailscale,
  tailscaleAvailable,
  tailscaleErrorKey,
} from '../src/platform/tailscale.ts'

test('审批、恢复中、网络失败与登录提示分别显示，只有暂时网络错误自动重试', () => {
  for (const [code, key, retriable] of [
    ['tailscaleApproval', 'approval', false],
    ['tailscaleConnecting', 'connecting', true],
    ['tailscaleConnect', 'connect', true],
    ['tailscaleAutoLogin', 'switch', false],
  ]) {
    const error = new Error(`[unreachable] [${code}] test`)
    assert.equal(tailscaleErrorKey(error), `tailscale.error.${key}`)
    assert.equal(sshFailure(error).retriable, retriable)
  }
})

test('Tailscale 控制地址：默认、HTTPS Headscale、拒绝明文与凭据', () => {
  assert.equal(controlURL(''), '')
  assert.equal(controlURL(' https://headscale.example/ '), 'https://headscale.example')
  for (const value of [
    'http://host',
    'https://u:p@host',
    'https://host?k=secret',
    'https://host#x',
    'host',
    'https:///',
  ]) {
    assert.throws(() => controlURL(value), /tailscaleControl/)
  }
})

test('Tailscale 平台缺失显示不可用，原生报错保留给界面', async () => {
  natives.LitchSsh = {}
  assert.equal(tailscaleAvailable(), false)
  natives.LitchSsh = {
    tailscaleAvailable: () => true,
    tailscaleLogin: () => {
      throw new Error('[tailscaleStorage] locked')
    },
  }
  assert.equal(tailscaleAvailable(), true)
  await assert.rejects(tailscale.login(''), /tailscaleStorage/)
  assert.equal(
    tailscaleErrorKey(new Error('[unreachable] [tailscaleLogin] login required')),
    'tailscale.error.login',
  )
  const failure = sshFailure(new Error('[unreachable] [tailscaleLogin] login required'))
  assert.equal(failure.retriable, false)
})

test('指纹探测与所有 SSH 操作传递同一网络选择，默认仍为直连', async () => {
  const targets = []
  const probes = []
  natives.LitchSsh = {
    probeHost: (...args) => {
      probes.push(args)
      return '{}'
    },
    runScript: (target) => {
      targets.push(JSON.parse(target))
      return '{}'
    },
    openStream: (_id, target) => {
      targets.push(JSON.parse(target))
      return '{"url":"ws://127.0.0.1"}'
    },
    enrollPair: (target) => {
      targets.push(JSON.parse(target))
      return '{}'
    },
  }
  await ssh.probeHost('work', 22, 'user')
  await ssh.probeHost('work', 22, 'user', 'always')
  assert.deepEqual(probes, [
    ['work', 22, 'user', 'auto'],
    ['work', 22, 'user', 'always'],
  ])
  const target = {
    host: 'work',
    port: 22,
    user: 'user',
    tailscale: 'always',
    privateKey: 'test',
    passphrase: '',
    hostFingerprint: 'pinned',
  }
  await ssh.runScript(target, 'script', 'marker')
  await ssh.openStream('id', target, 'script', 'marker')
  await ssh.enrollPair(target, '{}')
  assert.deepEqual(targets, [target, target, target])
})
