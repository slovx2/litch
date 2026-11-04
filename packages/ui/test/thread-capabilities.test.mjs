import assert from 'node:assert/strict'
import test from 'node:test'
import { abilitiesForSession } from '../src/app/device.ts'

test('同一 Antigravity 的 SDK/ACP 行分别使用自己的能力，未声明才沿用默认', () => {
  const defaults = { images: true, remove: true, fork: true }
  const device = { harnesses: [{ id: 'agy', abilities: defaults }] }
  const sdk = { harness: 'agy', abilities: { images: false, remove: false, fork: false } }
  const acp = { harness: 'agy', abilities: { images: false, remove: true, fork: false } }
  assert.deepEqual(abilitiesForSession(device, sdk), sdk.abilities)
  assert.deepEqual(abilitiesForSession(device, acp), acp.abilities)
  assert.equal(abilitiesForSession(device, { harness: 'agy' }), defaults)
  assert.equal(abilitiesForSession(device, sdk).images, false)
  assert.equal(abilitiesForSession(undefined, sdk), sdk.abilities)
})
