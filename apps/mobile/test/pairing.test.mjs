// 扫码绑定手机这一头的纯逻辑（src/platform/pairing.ts）：认配对文本、拼登记那一行、认回话和错误、流程的各步、删设备时撤钥匙。
// 原生的 SSH 模块和核心都用假的顶替，流程照真的走。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodePairPayload } from '../../../packages/protocol/src/device-pairing.mts'
import {
  enrollFailure,
  enrollLine,
  enrollTarget,
  looksLikePair,
  parseEnrollOutput,
  parsePairText,
  phoneNameOf,
  revokeOwnKey,
  runPairing,
} from '../src/platform/pairing.ts'

const NOW = 1_800_000_000_000
const payload = {
  v: 1,
  n: '家里的 Mac',
  h: 'mac.tail',
  p: 2222,
  u: 'song',
  k: { t: 'ssh-ed25519', f: 'SHA256:abcdefg' },
  s: 'A'.repeat(43),
  i: 'Ab3dEf6hIj9kLm2n',
  e: NOW + 60_000,
}
const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const APPROVAL_KEY = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ='

test('配对文本：认前缀和格式，过期的照样解出来给人看', () => {
  const text = encodePairPayload(payload)
  assert.equal(looksLikePair(`  ${text}\n`), true)
  assert.equal(looksLikePair('https://example.com'), false)
  const parsed = parsePairText(text, NOW)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.expired, false)
  assert.deepEqual(parsed.payload, payload)
  assert.equal(parsePairText(text, payload.e).expired, true)
  assert.deepEqual(parsePairText('LITCHPAIR1:坏的', NOW), { ok: false, reason: 'notPair' })
  assert.deepEqual(parsePairText('随便一段话', NOW), { ok: false, reason: 'notPair' })
})

test('登记：用一次性钥匙、只协商二维码里那一种主机钥匙、钉住它的指纹；公钥不带注释', () => {
  assert.deepEqual(enrollTarget(payload, 'ignored'), {
    host: 'mac.tail',
    port: 2222,
    user: 'song',
    privateKey: '',
    passphrase: '',
    seed: payload.s,
    hostKeyType: 'ssh-ed25519',
    hostFingerprint: 'SHA256:abcdefg',
  })
  assert.deepEqual(JSON.parse(enrollLine(`${PUBLIC} litch-mobile\n`, 'Pixel 8')), {
    v: 1,
    publicKey: PUBLIC,
    name: 'Pixel 8',
  })
  assert.deepEqual(JSON.parse(enrollLine(PUBLIC, 'Pixel 8', APPROVAL_KEY)), {
    v: 1,
    publicKey: PUBLIC,
    name: 'Pixel 8',
    approvalKey: APPROVAL_KEY,
  })
})

test('回话：成功、七种错误、认不出的错误、不是 JSON', () => {
  assert.deepEqual(parseEnrollOutput('{"ok":true,"phoneId":"f83898df0bef57a4"}'), { ok: true })
  for (const error of [
    'expired',
    'used',
    'rejected',
    'timeout',
    'invalid',
    'keysFile',
    'unavailable',
  ]) {
    assert.deepEqual(parseEnrollOutput(JSON.stringify({ ok: false, error, message: 'm' })), {
      ok: false,
      problem: error,
      message: 'm',
    })
  }
  assert.equal(parseEnrollOutput('{"ok":false,"error":"新的错误"}').problem, 'unknown')
  assert.equal(parseEnrollOutput('bash: litch: command not found'), null)
  assert.equal(parseEnrollOutput('{"ok":"yes"}'), null)
})

test('SSH 模块的错误：钥匙被拒、指纹不对、没回话、连不上', () => {
  const said = (text) => enrollFailure(new Error(`Call rejected.\n→ Caused by: ${text}`))
  assert.equal(said('[auth] unable to authenticate').problem, 'refused')
  assert.equal(said('[hostKeyChanged] 期望 a 实际 b').problem, 'hostKey')
  assert.equal(said('[enroll] 对面没有给出登记结果').problem, 'noAnswer')
  assert.equal(said('[unreachable] dial tcp: timeout').problem, 'unreachable')
  assert.equal(said('认不出来').problem, 'unreachable')
  assert.equal(said('[invalid] 不支持的主机钥匙类型').problem, 'unknown')
  assert.equal(said('[auth] unable to authenticate').detail, '[auth] unable to authenticate')
})

test('手机名：安卓是厂商加型号（不重复），控制字符去掉、截到 64 个字', () => {
  assert.equal(
    phoneNameOf({ Manufacturer: 'Google', Model: 'Pixel 8' }, 'android'),
    'Google Pixel 8',
  )
  assert.equal(
    phoneNameOf({ Manufacturer: 'samsung', Model: 'SM-S918B' }, 'android'),
    'samsung SM-S918B',
  )
  assert.equal(phoneNameOf({ Brand: 'xiaomi', Model: 'Xiaomi 14' }, 'android'), 'Xiaomi 14')
  assert.equal(phoneNameOf({ Manufacturer: 'A\u0007', Model: 'B\n' }, 'android'), 'A B')
  assert.equal(phoneNameOf({ systemName: 'iOS' }, 'ios'), 'iOS')
  assert.equal(phoneNameOf({}, 'android'), 'Litch')
  assert.equal(phoneNameOf({ Model: 'x'.repeat(100) }, 'android').length, 64)
})

/** 一套假的依赖，记下调了什么 */
function fakeDeps({ enroll, check = async () => ({ ok: true }) } = {}) {
  const calls = []
  const deps = {
    phoneName: 'Pixel 8',
    async makeKey() {
      calls.push('makeKey')
      return { id: 'k-0123456789abcdef', publicKey: `${PUBLIC} litch-mobile` }
    },
    async dropKey(id) {
      calls.push(`dropKey ${id}`)
    },
    async privateKey(id) {
      calls.push(`privateKey ${id}`)
      return 'PRIVATE'
    },
    async approvalKey() {
      calls.push('approvalKey')
      return APPROVAL_KEY
    },
    async confirmCode(pairId, publicKey, approvalKey) {
      calls.push(`code ${pairId} ${publicKey === PUBLIC}${approvalKey ? ` ${approvalKey}` : ''}`)
      return approvalKey ? '977558' : '965093'
    },
    async enroll(target, line) {
      calls.push(
        target.enrollCommand
          ? `enroll ${target.privateKey} ${target.enrollCommand} ${JSON.parse(line).name}`
          : `enroll ${target.seed === payload.s} ${JSON.parse(line).name}${JSON.parse(line).approvalKey ? ` ${JSON.parse(line).approvalKey}` : ''}`,
      )
      return enroll ? enroll() : '{"ok":true}'
    },
    trust(host, port, key) {
      calls.push(`trust ${host}:${port} ${key.fingerprint} ${key.keyType}`)
    },
    async check(target) {
      calls.push(`check ${target.keyFile} ${target.port}`)
      return check()
    },
    async add(name, target) {
      calls.push(`add ${name} ${target.host}`)
      return 'dev-1'
    },
  }
  return { deps, calls }
}

test('流程：生成钥匙 → 确认码 → 登记 → 记主机指纹 → 检查 → 添加', async () => {
  const { deps, calls } = fakeDeps()
  const steps = []
  const result = await runPairing(payload, deps, (step) => steps.push(step))
  assert.deepEqual(result, { ok: true, deviceId: 'dev-1', checked: true })
  assert.deepEqual(steps, [
    { step: 'key' },
    { step: 'enroll', code: '965093' },
    { step: 'check' },
    { step: 'add' },
  ])
  assert.deepEqual(calls, [
    'makeKey',
    'code Ab3dEf6hIj9kLm2n true',
    'enroll true Pixel 8',
    'trust mac.tail:2222 SHA256:abcdefg ssh-ed25519',
    'check k-0123456789abcdef 2222',
    'add 家里的 Mac mac.tail',
  ])
})

test('流程：二维码里有 a（设备认批准公钥）时登记带上批准公钥，确认码把它算进去；没有 a 不取也不带', async () => {
  const { deps, calls } = fakeDeps()
  const steps = []
  const result = await runPairing({ ...payload, a: 1 }, deps, (step) => steps.push(step))
  assert.equal(result.ok, true)
  assert.deepEqual(steps[1], { step: 'enroll', code: '977558' })
  assert.deepEqual(calls.slice(0, 4), [
    'makeKey',
    'approvalKey',
    `code Ab3dEf6hIj9kLm2n true ${APPROVAL_KEY}`,
    `enroll true Pixel 8 ${APPROVAL_KEY}`,
  ])
  const old = fakeDeps()
  await runPairing(payload, old.deps, () => {})
  assert.equal(old.calls.includes('approvalKey'), false)
})

test('流程：电脑上拒绝了、一次性钥匙被拒——不记指纹、不添加，刚生成的钥匙删掉', async () => {
  const rejected = fakeDeps({ enroll: () => '{"ok":false,"error":"rejected","message":"拒绝"}' })
  assert.deepEqual(await runPairing(payload, rejected.deps, () => {}), {
    ok: false,
    problem: 'rejected',
    detail: '拒绝',
  })
  assert.equal(rejected.calls.at(-1), 'dropKey k-0123456789abcdef')
  assert.equal(
    rejected.calls.some((call) => call.startsWith('trust') || call.startsWith('add')),
    false,
  )

  const refused = fakeDeps({
    enroll: () => {
      throw new Error('[auth] unable to authenticate')
    },
  })
  const result = await runPairing(payload, refused.deps, () => {})
  assert.equal(result.problem, 'refused')
  assert.equal(refused.calls.at(-1), 'dropKey k-0123456789abcdef')

  const garbage = fakeDeps({ enroll: () => 'sh: pair-enroll: not found' })
  assert.deepEqual(await runPairing(payload, garbage.deps, () => {}), {
    ok: false,
    problem: 'noAnswer',
    detail: 'sh: pair-enroll: not found',
  })
})

test('流程：登记成了但自己的钥匙没连上——照样添加，标明没检查过；端口 22 记成默认', async () => {
  const { deps, calls } = fakeDeps({
    check: async () => ({ ok: false, failure: { stage: 'auth' } }),
  })
  const result = await runPairing({ ...payload, p: 22, n: ' ' }, deps, () => {})
  assert.deepEqual(result, { ok: true, deviceId: 'dev-1', checked: false })
  assert.ok(calls.includes('check k-0123456789abcdef null'))
  // 别名是空的就用主机名
  assert.equal(calls.at(-1), 'add mac.tail mac.tail')
  assert.equal(
    calls.some((call) => call.startsWith('dropKey')),
    false,
  )
})

test('删设备时撤钥匙：按指纹找到自己、没连上不试、没登记过不用撤、出错照实说', async () => {
  const revoked = []
  const phones = async () => [
    { phoneId: 'aaaa', fingerprint: 'SHA256:other' },
    { phoneId: 'bbbb', fingerprint: 'SHA256:mine' },
  ]
  const revoke = async (id) => {
    revoked.push(id)
  }
  assert.deepEqual(
    await revokeOwnKey({ online: true, fingerprint: 'SHA256:mine', phones, revoke }),
    { kind: 'revoked' },
  )
  assert.deepEqual(revoked, ['bbbb'])
  assert.deepEqual(
    await revokeOwnKey({ online: true, fingerprint: 'SHA256:none', phones, revoke }),
    { kind: 'none' },
  )
  assert.deepEqual(
    await revokeOwnKey({ online: false, fingerprint: 'SHA256:mine', phones, revoke }),
    { kind: 'offline' },
  )
  assert.deepEqual(await revokeOwnKey({ online: true, fingerprint: null, phones, revoke }), {
    kind: 'none',
  })
  assert.deepEqual(
    await revokeOwnKey({
      online: true,
      fingerprint: 'SHA256:mine',
      phones: async () => {
        throw new Error('unsupported')
      },
      revoke,
    }),
    { kind: 'failed', reason: 'unsupported' },
  )
})

const tailscale = {
  v: 1,
  n: 'song-debian',
  h: 'song-debian.tail2e2f6a.ts.net',
  p: 22,
  u: 'root',
  k: { t: 'ssh-ed25519', f: 'SHA256:abcdefg' },
  m: 'tailscale',
  c: "'/root/.local/bin/codex-harness-adapter' pair-enroll --home '/root/.codex-harness-adapter' Ab3dEf6hIj9kLm2n",
  i: 'Ab3dEf6hIj9kLm2n',
  e: NOW + 60_000,
}

test('Tailscale 方式的码：解得出；登记用手机自己的私钥、执行二维码里的登记命令，不带种子', async () => {
  const parsed = parsePairText(encodePairPayload(tailscale), NOW)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.payload, tailscale)
  assert.deepEqual(enrollTarget(tailscale, 'PRIVATE'), {
    host: 'song-debian.tail2e2f6a.ts.net',
    port: 22,
    user: 'root',
    passphrase: '',
    hostKeyType: 'ssh-ed25519',
    hostFingerprint: 'SHA256:abcdefg',
    privateKey: 'PRIVATE',
    enrollCommand: tailscale.c,
  })
  const { deps, calls } = fakeDeps()
  const result = await runPairing(tailscale, deps, () => {})
  assert.deepEqual(result, { ok: true, deviceId: 'dev-1', checked: true })
  assert.deepEqual(calls.slice(0, 4), [
    'makeKey',
    'code Ab3dEf6hIj9kLm2n true',
    'privateKey k-0123456789abcdef',
    `enroll PRIVATE ${tailscale.c} Pixel 8`,
  ])
})

test('Tailscale 方式的错误：连不上 tailnet 地址、ACL 不让登、要浏览器验证', () => {
  const said = (text, code = tailscale) =>
    enrollFailure(new Error(`Call rejected.\n→ Caused by: ${text}`), code)
  assert.equal(
    said('[unreachable] dial tcp: lookup x.ts.net: no such host').problem,
    'tailscaleOff',
  )
  assert.equal(
    said('[unreachable] timeout', { ...tailscale, h: '192.168.1.5' }).problem,
    'unreachable',
  )
  assert.equal(said('[unreachable] timeout', payload).problem, 'unreachable')
  assert.equal(said('[auth] unable to authenticate').problem, 'denied')
  assert.deepEqual(said('[verify] https://login.tailscale.com/a/abc123'), {
    problem: 'verify',
    detail: 'https://login.tailscale.com/a/abc123',
  })
})
