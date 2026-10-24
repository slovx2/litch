// 手机答复的验签（approvals/verify.mts）和记下的批准钥匙（approvals/store.mts）：
// 伪造的答复、换了内容的卡片、重放、过期、同一手机号换了钥匙都不认；第一次批准记下并出提示；扫码核对过的不被顶掉。
// 钥匙文件在临时目录里，不碰真实的用户数据目录。
//   node scripts/test-approvals.mjs
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type ApprovalAnswer,
  approvalSignedText,
} from '../../../../packages/protocol/src/client-approvals.mjs'
import { approvalKeyFingerprint, TrustedPhones } from '../approvals/store.mjs'
import {
  approvalDesktopId,
  installPhoneApprovals,
  PhoneApprovals,
  type PhoneCard,
  type PhoneNotice,
  pairingKeyMatches,
  verifyPhoneAnswer,
} from '../approvals/verify.mjs'

/** 由 32 字节种子做一把 ed25519 */
function keyOf(seed: number[]) {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed),
  ])
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return { privateKey, approvalKey: spki.subarray(spki.length - 32).toString('base64') }
}

const PHONE = keyOf(Array.from({ length: 32 }, (_, i) => i + 1))
const AGENT = keyOf(Array.from({ length: 32 }, (_, i) => 200 - i))
const PHONE_ID = 'f83898df0bef57a4'
/** 正在跑的那个用例里这台桌面端的号（rig 里设） */
const DESKTOP_ID = { current: '' }

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'litch-approvals-'))
  const file = join(dir, 'trusted-phones.json')
  let time = 1_800_000_000_000
  const notices: PhoneNotice[] = []
  let changes = 0
  const make = () =>
    new PhoneApprovals({
      store: new TrustedPhones(file),
      now: () => time,
      notice: (notice) => notices.push(notice),
      changed: () => changes++,
    })
  const approvals = make()
  DESKTOP_ID.current = approvals.desktopId
  // 编号和随机数照内置浏览器的登录卡片（browser/passwords/signin.mts）出
  const card = (more: Partial<PhoneCard> = {}): PhoneCard => ({
    id: randomUUID(),
    nonce: randomBytes(16).toString('base64url'),
    origin: 'https://github.com',
    accounts: [{ ref: 'a1' }, { ref: 'a2' }],
    taskId: null,
    expiresAt: null,
    ...more,
  })
  return {
    dir,
    file,
    approvals,
    make,
    card,
    notices,
    changes: () => changes,
    tick: (ms: number) => {
      time += ms
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 手机照它看到的卡片签一份答复（桌面端号是卡片上带的，平常就是这台桌面端的） */
function answerFor(
  card: PhoneCard,
  key = PHONE,
  more: Partial<ApprovalAnswer> = {},
  signedOrigin = card.origin,
  desktopId = DESKTOP_ID.current,
): ApprovalAnswer {
  const base = {
    id: card.id,
    ref: 'a1' as string | null,
    decision: 'approve' as const,
    remember: false,
    phoneId: PHONE_ID,
    phoneName: 'Pixel 8',
    ...more,
  }
  const text = approvalSignedText(
    { id: card.id, nonce: card.nonce, desktopId, origin: signedOrigin },
    base,
  )
  return {
    ...base,
    approvalKey: key.approvalKey,
    signature: sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64'),
  }
}

test('约定里的测试向量：批准公钥、指纹、签名', () => {
  assert.equal(PHONE.approvalKey, 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=')
  assert.equal(approvalKeyFingerprint(PHONE.approvalKey), '65b6 0673 d6ed 884b')
  const text = approvalSignedText(
    {
      id: 'Ap7cK2mQ9xW4rT6v',
      nonce: 'Nq3vL8sD1fG5hJ0k',
      desktopId: 'Dz5yX2wV8uT1sR4q',
      origin: 'https://github.com',
    },
    { ref: 'a1', decision: 'approve', remember: false, phoneId: PHONE_ID },
  )
  assert.equal(
    sign(null, Buffer.from(text, 'utf8'), PHONE.privateKey).toString('base64'),
    'CN7xYgg3bNV+mLfeWMRmrBSPbHMehY5JKWZsnml5M/74XWpsoitp1YZPbsqV+k0saqYZWQ9V3WbJw7og4d0DAw==',
  )
})

test('第一次批准：验过签名就记下、当次生效，出提示；之后同一把照认，同一张卡片不能再用', () => {
  const r = rig()
  try {
    const card = r.card()
    const verdict = r.approvals.verify(card, answerFor(card))
    assert.deepEqual(verdict, {
      ok: true,
      phoneId: PHONE_ID,
      choice: 'a1',
      remember: false,
      firstSeen: true,
    })
    assert.deepEqual(r.notices, [
      { kind: 'firstSeen', phoneId: PHONE_ID, name: 'Pixel 8', fingerprint: '65b6 0673 d6ed 884b' },
    ])
    const [phone] = r.approvals.phones()
    assert.equal(phone?.source, 'firstApproval')
    assert.equal(phone?.deviceId, null)
    assert.equal(phone?.lastApprovedAt, 1_800_000_000_000)
    // 重放：同一张卡片的答复再来一次
    assert.deepEqual(r.approvals.verify(card, answerFor(card)), { ok: false, why: 'replay' })
    // 新卡片：认，不算第一次
    const next = r.card()
    const again = r.approvals.verify(
      next,
      answerFor(next, PHONE, { decision: 'decline', ref: null }),
    )
    assert.deepEqual(again, {
      ok: true,
      phoneId: PHONE_ID,
      choice: null,
      remember: false,
      firstSeen: false,
    })
    assert.equal(r.notices.length, 1)
    // 记在文件里，重开还在，桌面端号不变
    const reopened = r.make()
    assert.equal(reopened.phones().length, 1)
    assert.equal(reopened.desktopId, r.approvals.desktopId)
    assert.equal(JSON.parse(readFileSync(r.file, 'utf8')).phones[0].approvalKey, PHONE.approvalKey)
  } finally {
    r.close()
  }
})

test('伪造与篡改：签名不对、卡片号不对、别的桌面端、源和账号被换过、过期、非任务卡片勾了以后直接用', () => {
  const r = rig()
  try {
    const card = r.card()
    const good = answerFor(card)
    const cases: [string, unknown, PhoneCard][] = [
      ['shape', { ...good, signature: 'x' }, card],
      ['signature', { ...good, signature: answerFor(r.card()).signature }, card],
      // 设备把卡片的源换成假站给手机看：手机签的是假站，桌面端按自己的源核对
      ['signature', answerFor(card, PHONE, {}, 'https://github.evil.com'), card],
      // 签的是 a2，答复里改成 a1
      ['signature', { ...answerFor(card, PHONE, { ref: 'a2' }), ref: 'a1' }, card],
      ['card', answerFor(card), { ...card, id: randomUUID() }],
      // 发给别的桌面端的卡片（签的是别的桌面端号）
      ['signature', answerFor(card, PHONE, {}, card.origin, 'Other0desktop01x'), card],
      ['account', answerFor(card, PHONE, { ref: 'zz' }), card],
      ['remember', answerFor(card, PHONE, { remember: true }), card],
    ]
    for (const [why, answer, used] of cases)
      assert.deepEqual(r.approvals.verify(used, answer), { ok: false, why }, why)
    // 不认的都没记下任何东西
    assert.equal(r.approvals.phones().length, 0)
    // 定时任务的卡片可以勾
    const task = r.card({ taskId: 'task-1' })
    const remembered = r.approvals.verify(task, answerFor(task, PHONE, { remember: true }))
    assert.equal(remembered.ok && remembered.remember, true)
    // 过期
    const expiring = r.card({ expiresAt: 1_800_000_000_000 + 30 * 60_000 })
    r.tick(30 * 60_000)
    assert.deepEqual(r.approvals.verify(expiring, answerFor(expiring)), {
      ok: false,
      why: 'expired',
    })
  } finally {
    r.close()
  }
})

test('第一次批准记下的，同一手机号换了钥匙：两把都不认，等删掉；删掉后重新按第一次记', () => {
  const r = rig()
  try {
    const first = r.card()
    assert.equal(r.approvals.verify(first, answerFor(first)).ok, true)
    const forged = r.card()
    assert.deepEqual(r.approvals.verify(forged, answerFor(forged, AGENT)), {
      ok: false,
      why: 'keyMismatch',
    })
    assert.deepEqual(r.notices.at(-1), { kind: 'mismatch', phoneId: PHONE_ID, name: 'Pixel 8' })
    assert.equal(r.approvals.phones()[0]?.conflict, true)
    // 原来那把也不认了
    const later = r.card()
    assert.deepEqual(r.approvals.verify(later, answerFor(later)), { ok: false, why: 'keyMismatch' })
    assert.equal(r.approvals.forget(PHONE_ID), true)
    const fresh = r.card()
    const verdict = r.approvals.verify(fresh, answerFor(fresh))
    assert.equal(verdict.ok && verdict.firstSeen, true)
  } finally {
    r.close()
  }
})

test('扫码核对过的不被顶掉：别的钥匙不认，这把照旧能用；扫码会换掉对不上的记录', () => {
  const r = rig()
  try {
    r.approvals.trustFromPairing({
      phoneId: PHONE_ID,
      name: 'Pixel 8',
      approvalKey: PHONE.approvalKey,
      deviceId: 'local',
    })
    assert.equal(r.approvals.phones()[0]?.source, 'pairing')
    const forged = r.card()
    assert.deepEqual(r.approvals.verify(forged, answerFor(forged, AGENT)), {
      ok: false,
      why: 'keyMismatch',
    })
    assert.equal(r.approvals.phones()[0]?.conflict, false)
    const real = r.card()
    const verdict = r.approvals.verify(real, answerFor(real))
    assert.equal(verdict.ok && !verdict.firstSeen, true)
    // 第一次批准记下的、对不上的，重新扫码后换成核对过的
    const other = 'aaaaaaaaaaaaaaaa'
    const card = r.card()
    r.approvals.verify(card, answerFor(card, AGENT, { phoneId: other }))
    const clash = r.card()
    r.approvals.verify(clash, answerFor(clash, PHONE, { phoneId: other }))
    assert.equal(r.approvals.phones().find((p) => p.phoneId === other)?.conflict, true)
    r.approvals.trustFromPairing({
      phoneId: other,
      name: 'iPhone',
      approvalKey: PHONE.approvalKey,
      deviceId: null,
    })
    const fixed = r.approvals.phones().find((p) => p.phoneId === other)
    assert.deepEqual([fixed?.conflict, fixed?.source], [false, 'pairing'])
  } finally {
    r.close()
  }
})

test('读不懂的文件挪到一边重新开始；没装好时没有桌面端号、一律不认', () => {
  const r = rig()
  try {
    writeFileSync(r.file, '{not json')
    const store = new TrustedPhones(r.file)
    assert.equal(store.list().length, 0)
    assert.match(store.desktopId, /^[A-Za-z0-9_-]{22}$/)
    installPhoneApprovals(null)
    assert.equal(approvalDesktopId(), null)
    const card = r.card()
    assert.deepEqual(verifyPhoneAnswer(card, answerFor(card)), { ok: false, why: 'unavailable' })
    installPhoneApprovals(r.approvals)
    assert.equal(approvalDesktopId(), r.approvals.desktopId)
    assert.equal(verifyPhoneAnswer(card, answerFor(card)).ok, true)
    installPhoneApprovals(null)
  } finally {
    r.close()
  }
})

test('扫码时记下之前自己重算确认码和手机号：设备塞进别的批准公钥、报错确认码都不认', () => {
  const input = {
    pairId: 'Ab3dEf6hIj9kLm2n',
    phoneId: PHONE_ID,
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    approvalKey: PHONE.approvalKey,
    code: '977558',
  }
  assert.equal(pairingKeyMatches(input), true)
  assert.equal(pairingKeyMatches({ ...input, approvalKey: AGENT.approvalKey }), false)
  assert.equal(pairingKeyMatches({ ...input, code: '965093' }), false)
  assert.equal(pairingKeyMatches({ ...input, phoneId: 'aaaaaaaaaaaaaaaa' }), false)
  assert.equal(pairingKeyMatches({ ...input, publicKey: 'ssh-rsa AAAA' }), false)
})
