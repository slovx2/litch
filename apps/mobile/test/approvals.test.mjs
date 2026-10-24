// 手机批准代理登录的纯逻辑（src/detail/approvals/logic.ts）：签名内容和协议里的测试向量一字不差、
// 用户名打码、过期、能不能代填、拒绝和勾选的规矩。签名拿 node:crypto 的 ed25519 顶替原生模块。
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { test } from 'node:test'
import {
  approvalSignedText,
  isApprovalAnswer,
} from '../../../packages/protocol/src/client-approvals.mts'
import {
  abilityOf,
  buildAnswer,
  isExpired,
  knownBlock,
  originParts,
  remainingMs,
  remainingText,
  shownName,
} from '../src/detail/approvals/logic.ts'

// 协议里的测试向量：私钥种子 0x01……0x20
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
const APPROVAL_KEY = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ='
const FINGERPRINT = '65b6 0673 d6ed 884b'
const SIGNATURE =
  'CN7xYgg3bNV+mLfeWMRmrBSPbHMehY5JKWZsnml5M/74XWpsoitp1YZPbsqV+k0saqYZWQ9V3WbJw7og4d0DAw=='
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
    device: 'song-debian',
    accounts: [
      { ref: 'a1', masked: 'so•••@gmail.com' },
      { ref: 'a2', masked: 'wo•••' },
    ],
    task: null,
    fillBlocked: null,
    ...over.summary,
  },
})

test('批准钥匙的向量：公钥、指纹和协议里写的一样', () => {
  assert.equal(rawPublic.toString('base64'), APPROVAL_KEY)
  const hex = createHash('sha256').update(rawPublic).digest('hex').slice(0, 16)
  assert.equal(hex.match(/.{4}/g).join(' '), FINGERPRINT)
})

test('批准：签名内容和协议的向量一字不差，签名能用批准公钥验过，答复形状对', async () => {
  const answer = await buildAnswer(card(), { ref: 'a1', remember: false }, signer)
  assert.equal(answer.signature, SIGNATURE)
  assert.deepEqual(
    { ...answer, signature: undefined },
    {
      id: 'Ap7cK2mQ9xW4rT6v',
      ref: 'a1',
      decision: 'approve',
      remember: false,
      phoneId: 'f83898df0bef57a4',
      phoneName: 'Pixel 8',
      approvalKey: APPROVAL_KEY,
      signature: undefined,
    },
  )
  assert.equal(isApprovalAnswer(answer), true)
  const text = approvalSignedText(
    {
      id: answer.id,
      nonce: 'Nq3vL8sD1fG5hJ0k',
      desktopId: 'Dz5yX2wV8uT1sR4q',
      origin: 'https://github.com',
    },
    answer,
  )
  assert.equal(
    verify(
      null,
      Buffer.from(text),
      createPublicKey(privateKey),
      Buffer.from(answer.signature, 'base64'),
    ),
    true,
  )
  // 签的是手机看到的源：设备把卡片上的源换了，桌面端拿自己记着的源验不过
  const forged = approvalSignedText(
    {
      id: answer.id,
      nonce: 'Nq3vL8sD1fG5hJ0k',
      desktopId: 'Dz5yX2wV8uT1sR4q',
      origin: 'https://github.io',
    },
    answer,
  )
  assert.equal(
    verify(
      null,
      Buffer.from(forged),
      createPublicKey(privateKey),
      Buffer.from(answer.signature, 'base64'),
    ),
    false,
  )
})

test('拒绝：ref 是 null、不带勾选；卡片上没有的账号不签', async () => {
  const declined = await buildAnswer(card(), { ref: null, remember: true }, signer)
  assert.equal(declined.decision, 'decline')
  assert.equal(declined.ref, null)
  assert.equal(declined.remember, false)
  assert.equal(isApprovalAnswer(declined), true)
  await assert.rejects(buildAnswer(card(), { ref: 'a9', remember: false }, signer))
})

test('勾选“以后直接用这个账号”只在定时任务的卡片上算数', async () => {
  const plain = await buildAnswer(card(), { ref: 'a2', remember: true }, signer)
  assert.equal(plain.remember, false)
  const task = card({ summary: { task: { id: 'task1', name: '每天看看' } }, expiresAt: 9e12 })
  const remembered = await buildAnswer(task, { ref: 'a2', remember: true }, signer)
  assert.equal(remembered.remember, true)
  assert.notEqual(remembered.signature, plain.signature)
})

test('用户名打码：给来的带打码记号照原样，不带的照桌面端的规则打码', () => {
  assert.equal(shownName('so•••@gmail.com'), 'so•••@gmail.com')
  assert.equal(shownName('songsiyu@gmail.com'), 'so•••@gmail.com')
  assert.equal(shownName('ab@x.com'), 'a•••@x.com')
  assert.equal(shownName('admin'), 'ad•••')
  assert.equal(shownName('雪花飘飘'), '雪花•••')
})

test('过期：不限时的不过期；定时任务的到点就过期，剩下的时间说成 m:ss', () => {
  assert.equal(isExpired(card(), 9e15), false)
  assert.equal(remainingMs(card(), 5), null)
  const timed = card({ expiresAt: 1_000_000 })
  assert.equal(isExpired(timed, 999_999), false)
  assert.equal(isExpired(timed, 1_000_000), true)
  assert.equal(remainingMs(timed, 1_000_500), 0)
  assert.equal(remainingText(remainingMs(timed, 1_000_000 - 30 * 60_000)), '30:00')
  assert.equal(remainingText(61_001), '1:02')
})

test('能做什么：有账号能批、没账号要到电脑上、预检不过、过期', () => {
  assert.equal(abilityOf(card(), 0), 'fill')
  assert.equal(abilityOf(card({ summary: { accounts: [] } }), 0), 'noAccount')
  assert.equal(abilityOf(card({ summary: { fillBlocked: 'insecure' } }), 0), 'blocked')
  assert.equal(
    abilityOf(card({ expiresAt: 10, summary: { fillBlocked: 'insecure' } }), 10),
    'expired',
  )
})

test('来源拆三段：突出可注册域名，两段后缀多带一段，IP 和短主机名整个突出', () => {
  assert.deepEqual(originParts('https://accounts.google.com'), {
    lead: 'https://accounts.',
    main: 'google.com',
    tail: '',
  })
  assert.deepEqual(originParts('https://login.bbc.co.uk:8443'), {
    lead: 'https://login.',
    main: 'bbc.co.uk',
    tail: ':8443',
  })
  assert.deepEqual(originParts('http://192.168.1.10:3000'), {
    lead: 'http://',
    main: '192.168.1.10',
    tail: ':3000',
  })
  assert.equal(originParts('不是网址').main, '不是网址')
  assert.equal(knownBlock('insecure'), 'insecure')
  assert.equal(knownBlock('别的'), null)
})
