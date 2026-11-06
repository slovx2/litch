import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { encodeFrame, FrameReader } from '../src/wire.mjs'

test('TS/Swift/Rust 共用黄金帧：逐字节分片、粘包与重编码', () => {
  const fixtures = JSON.parse(
    readFileSync(new URL('./native-frames.json', import.meta.url), 'utf8'),
  ) as { value: unknown; hex: string }[]
  const reader = new FrameReader()
  for (const fixture of fixtures) {
    assert.equal(encodeFrame(fixture.value).toString('hex'), fixture.hex)
    const bytes = Buffer.from(fixture.hex, 'hex')
    for (const byte of bytes) reader.push(Buffer.from([byte]))
    assert.deepEqual(reader.next(), fixture.value)
    assert.equal(reader.next(), undefined)
  }
})
