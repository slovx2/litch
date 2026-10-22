// 二维码文本的编解码（packages/protocol/src/device-pairing.mts）：桌面端、命令行出码，手机解，三处要一字不差。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodePairPayload,
  encodePairPayload,
  isTailnetHost,
  PAIR_PAYLOAD_PREFIX,
  type PairPayload,
  pairModeOf,
  tailscaleVerifyUrl,
} from '../../protocol/src/device-pairing.mjs'

const seed = Buffer.alloc(32, 7).toString('base64url')

const sample: PairPayload = {
  v: 1,
  n: '开发机 song-debian',
  h: 'device-ts',
  p: 2222,
  u: 'song',
  k: { t: 'ssh-ed25519', f: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' },
  s: seed,
  i: 'Ab3dEf6hIj9kLm2n',
  e: 1_792_000_000_000,
}

test('编出来是前缀加 base64url（无填充）的 UTF-8 JSON，和 Node 的实现一致', () => {
  const text = encodePairPayload(sample)
  assert.ok(text.startsWith(PAIR_PAYLOAD_PREFIX))
  const body = text.slice(PAIR_PAYLOAD_PREFIX.length)
  assert.equal(body, Buffer.from(JSON.stringify(sample), 'utf8').toString('base64url'))
  assert.match(body, /^[A-Za-z0-9_-]+$/)
})

test('解回来一样；前后空白不碍事；含四字节字符的名字也行', () => {
  assert.deepEqual(decodePairPayload(`  ${encodePairPayload(sample)}\n`), sample)
  const emoji = { ...sample, n: '手机🙂' }
  assert.deepEqual(decodePairPayload(encodePairPayload(emoji)), emoji)
})

test('不是配对文本、字段缺了、种子不是 32 字节，都返回 null', () => {
  assert.equal(decodePairPayload('hello'), null)
  assert.equal(decodePairPayload(`${PAIR_PAYLOAD_PREFIX}!!!`), null)
  const wrap = (value: unknown) =>
    PAIR_PAYLOAD_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  assert.equal(decodePairPayload(wrap({ ...sample, v: 2 })), null)
  assert.equal(decodePairPayload(wrap({ ...sample, h: ' ' })), null)
  assert.equal(decodePairPayload(wrap({ ...sample, p: 70000 })), null)
  assert.equal(decodePairPayload(wrap({ ...sample, k: { t: 'ssh-ed25519', f: 'MD5:aa' } })), null)
  assert.equal(
    decodePairPayload(wrap({ ...sample, s: Buffer.alloc(16).toString('base64url') })),
    null,
  )
  assert.equal(decodePairPayload(wrap({ ...sample, i: '' })), null)
})

const tailscale: PairPayload = {
  v: 1,
  n: '开发机 song-debian',
  h: 'song-debian.tail2e2f6a.ts.net',
  p: 22,
  u: 'root',
  k: { t: 'ssh-ed25519', f: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' },
  m: 'tailscale',
  c: "'/opt/litch/bin/codex-harness-adapter' pair-enroll --home '/root/.codex-harness-adapter' Ab3dEf6hIj9kLm2n",
  i: 'Ab3dEf6hIj9kLm2n',
  e: 1_792_000_000_000,
}

/** 命令行的 Go 那份（pair_test.go 的 pairTailscaleSample）断言和它一字不差 */
const TAILSCALE_TEXT =
  'LITCHPAIR1:eyJ2IjoxLCJuIjoi5byA5Y-R5py6IHNvbmctZGViaWFuIiwiaCI6InNvbmctZGViaWFuLnRhaWwyZTJmNmEudHMubmV0IiwicCI6MjIsInUiOiJyb290IiwiayI6eyJ0Ijoic3NoLWVkMjU1MTkiLCJmIjoiU0hBMjU2OitEaVkzd3Z2VjZUdUpKaGJwWmlzRi96TERBMHpQTVN2SGRrcjRVdkNPcVUifSwibSI6InRhaWxzY2FsZSIsImMiOiInL29wdC9saXRjaC9iaW4vY29kZXgtaGFybmVzcy1hZGFwdGVyJyBwYWlyLWVucm9sbCAtLWhvbWUgJy9yb290Ly5jb2RleC1oYXJuZXNzLWFkYXB0ZXInIEFiM2RFZjZoSWo5a0xtMm4iLCJpIjoiQWIzZEVmNmhJajlrTG0ybiIsImUiOjE3OTIwMDAwMDAwMDB9'

test('Tailscale 方式：键的顺序固定为 v n h p u k m c i e，解回来一样', () => {
  const text = encodePairPayload(tailscale)
  assert.equal(text, TAILSCALE_TEXT)
  const body = Buffer.from(text.slice(PAIR_PAYLOAD_PREFIX.length), 'base64url').toString('utf8')
  assert.deepEqual(Object.keys(JSON.parse(body)), [
    'v',
    'n',
    'h',
    'p',
    'u',
    'k',
    'm',
    'c',
    'i',
    'e',
  ])
  assert.deepEqual(decodePairPayload(text), tailscale)
  // 一次性钥匙方式的顺序不变：和原来 JSON.stringify(sample) 的一样
  const keyed = Buffer.from(
    encodePairPayload(sample).slice(PAIR_PAYLOAD_PREFIX.length),
    'base64url',
  ).toString('utf8')
  assert.deepEqual(Object.keys(JSON.parse(keyed)), ['v', 'n', 'h', 'p', 'u', 'k', 's', 'i', 'e'])
})

test('Tailscale 方式：命令空的、多行的，方式不认识的，两种字段混着的，都返回 null', () => {
  const wrap = (value: unknown) =>
    PAIR_PAYLOAD_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  assert.equal(decodePairPayload(wrap({ ...tailscale, c: ' ' })), null)
  assert.equal(decodePairPayload(wrap({ ...tailscale, c: 'a\nb' })), null)
  assert.equal(decodePairPayload(wrap({ ...tailscale, c: undefined })), null)
  assert.equal(decodePairPayload(wrap({ ...sample, m: 'other' })), null)
  // 一次性钥匙方式缺了种子
  assert.equal(decodePairPayload(wrap({ ...tailscale, m: undefined })), null)
})

test('isTailnetHost、pairModeOf：横幅优先，读不到时看设备自报和地址', () => {
  for (const host of [
    'song-debian.tail2e2f6a.ts.net',
    'X.TS.NET.',
    '100.64.0.1',
    '100.127.255.255',
  ])
    assert.equal(isTailnetHost(host), true, host)
  for (const host of [
    '192.168.1.101',
    '100.63.0.1',
    '100.128.0.1',
    'ts.net.example.com',
    'song-debian',
  ])
    assert.equal(isTailnetHost(host), false, host)
  assert.equal(pairModeOf('SSH-2.0-Tailscale', false, '192.168.1.1'), 'tailscale')
  assert.equal(pairModeOf('SSH-2.0-OpenSSH_9.2p1 Debian', true, 'a.ts.net'), 'key')
  assert.equal(pairModeOf(null, true, 'a.ts.net'), 'tailscale')
  assert.equal(pairModeOf(null, true, '192.168.1.1'), 'key')
  assert.equal(pairModeOf(null, false, 'a.ts.net'), 'key')
})

test('tailscaleVerifyUrl：认 tailscaled 在登录阶段打的那句', () => {
  const said =
    '# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/l2b3c4d5e6\n'
  assert.equal(tailscaleVerifyUrl(said), 'https://login.tailscale.com/a/l2b3c4d5e6')
  assert.equal(
    tailscaleVerifyUrl('To authenticate, visit: https://hs.example.com/a/xyz'),
    'https://hs.example.com/a/xyz',
  )
  assert.equal(tailscaleVerifyUrl('Permission denied (publickey).'), null)
})
