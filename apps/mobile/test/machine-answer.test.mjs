import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import test from 'node:test'
import {
  machineApprovalPayload,
  machineApprovalSignedText,
} from '../../../packages/protocol/src/machine-approvals.mts'
import { buildMachineAnswer } from '../src/detail/requests/machine-answer.ts'

test('手机只为显示的冻结预览签名，答复绑定选择和期限', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const hash = async (data) => createHash('sha256').update(data).digest('hex')
  const signMe = async (data) => sign(null, Buffer.from(data), privateKey).toString('base64')
  const now = Date.now()
  const card = {
    id: randomUUID(),
    threadId: 'line',
    turnId: 'turn',
    action: 'write',
    target: '/work/文件',
    cwd: null,
    desktop: 'Mac',
    expiresAt: now + 1_000,
  }
  const review = {
    desktopId: randomUUID(),
    nonce: randomUUID(),
    version: 1,
    details: '{"content":"写入"}',
    snapshotHash: '1'.repeat(64),
  }
  card.review = { ...review, payloadHash: await hash(machineApprovalPayload(card, review)) }
  const phoneId = 'f83898df0bef57a4'
  for (const choice of [
    { decision: 'once' },
    { decision: 'timed', hours: 4 },
    { decision: 'decline' },
  ]) {
    const answer = await buildMachineAnswer(card, choice, phoneId, hash, signMe, () => now)
    assert.ok(answer)
    const signed = (body) =>
      verify(
        null,
        Buffer.from(machineApprovalSignedText(body)),
        publicKey,
        Buffer.from(answer.signature, 'base64'),
      )
    assert.equal(signed(answer), true)
    assert.equal(signed({ ...answer, decision: 'timed', hours: 24 }), false)
  }
  const refuseToSign = () => assert.fail('不应签名')
  const once = { decision: 'once' }
  assert.equal(
    await buildMachineAnswer(
      { ...card, review: { ...card.review, details: '伪造预览' } },
      once,
      phoneId,
      hash,
      refuseToSign,
    ),
    null,
  )
  assert.equal(
    await buildMachineAnswer(
      { ...card, target: '/work/伪造路径' },
      once,
      phoneId,
      hash,
      refuseToSign,
    ),
    null,
  )
  assert.equal(
    await buildMachineAnswer(card, once, phoneId, hash, refuseToSign, () => card.expiresAt),
    null,
  )
})
