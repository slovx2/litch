// 手机批准代理登录的纯逻辑（src/detail/approvals/logic.ts）：签名内容和协议里的测试向量一字不差、
// 用户名打码、过期、能不能代填、拒绝和勾选的规矩。签名拿 node:crypto 的 ed25519 顶替原生模块。
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { test } from 'node:test'
import { approvalSignedText } from '../../../packages/protocol/src/client-approvals.mts'
import { buildAnswer } from '../src/detail/approvals/logic.ts'

// 协议里的测试向量：私钥种子 0x01……0x20
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
const APPROVAL_KEY = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ='
const FINGERPRINT = '65b6 0673 d6ed 884b'
// PKCS#8 里 ed25519 私钥的固定前缀，后接 32 字节种子
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
  format: 'der',
  type: 'pkcs8',
})
const rawPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)

const signer = {
  phoneId: 'f83898df0bef57a4',
  phoneName: 'Pixel 8',
  approvalKey: APPROVAL_KEY,
  sign: async (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64'),
}

test('自身访问三档签入 ref，不能跨档位重放签名，不使用 remember', async () => {
  const self = {
    ...card(),
    kind: 'computerSelf',
    summary: { origin: 'litch://computer-self', device: 'desktop' },
  }
  for (const ref of ['once', 'session', 'always', null]) {
    const answer = await buildAnswer(self, { ref, remember: true }, signer)
    assert.equal(answer.ref, ref)
    assert.equal(answer.remember, false)
    const identity = { ...self, origin: self.summary.origin }
    assert.equal(
      verify(
        null,
        Buffer.from(approvalSignedText(identity, answer)),
        createPublicKey(privateKey),
        Buffer.from(answer.signature, 'base64'),
      ),
      true,
    )
    assert.equal(
      verify(
        null,
        Buffer.from(approvalSignedText(identity, { ...answer, ref: 'forged' })),
        createPublicKey(privateKey),
        Buffer.from(answer.signature, 'base64'),
      ),
      false,
    )
  }
  await assert.rejects(buildAnswer(self, { ref: 'forever', remember: false }, signer))
})

const card = (over = {}) => ({
  id: 'Ap7cK2mQ9xW4rT6v',
  threadId: 't1',
  kind: 'browserSignIn',
  desktopId: 'Dz5yX2wV8uT1sR4q',
  nonce: 'Nq3vL8sD1fG5hJ0k',
  expiresAt: null,
  openedAt: 1,
  ...over,
  summary: {
    origin: 'https://github.com',
    site: 'GitHub',
    reason: '要看私有仓库',
    device: 'linux-test',
    accounts: [
      { ref: 'a1', masked: 'so•••@example.com' },
      { ref: 'a2', masked: 'wo•••' },
    ],
    task: null,
    fillBlocked: null,
    ...over.summary,
  },
})

test('网站审批只读：手机不能为站点许可生成批准或拒绝签名', async () => {
  const site = {
    ...card(),
    kind: 'browserSite',
    summary: {
      origin: 'https://example.com',
      device: 'Desktop',
      browser: 'chrome',
    },
  }
  for (const ref of ['session', null])
    await assert.rejects(buildAnswer(site, { ref, remember: false }, signer), /桌面会话/)
})

test('批准钥匙的向量：公钥、指纹和协议里写的一样', () => {
  assert.equal(rawPublic.toString('base64'), APPROVAL_KEY)
  const hex = createHash('sha256').update(rawPublic).digest('hex').slice(0, 16)
  assert.equal(hex.match(/.{4}/g).join(' '), FINGERPRINT)
})

test('旧代理代填卡不生成批准或拒绝签名', async () => {
  for (const ref of ['a1', null])
    await assert.rejects(buildAnswer(card(), { ref, remember: false }, signer), /代理代填已移除/)
})
