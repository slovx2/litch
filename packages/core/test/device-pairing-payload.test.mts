// 二维码文本的编解码（packages/protocol/src/device-pairing.mts）：桌面端、命令行出码，手机解，三处要一字不差。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodePairPayload,
  encodePairPayload,
  PAIR_PAYLOAD_PREFIX,
  type PairPayload,
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
