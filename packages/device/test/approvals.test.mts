// 手机上批准在设备进程里的部分：卡片只放内存、按连接记，答复原样转给发卡片的那条，形状不对、卡片不在、
// 次数太多都不转；连接断了、过期、close 都收掉。时间用假时钟拨。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPROVAL_ANSWERS_MAX,
  APPROVAL_MAX_PER_CONNECTION,
} from '../../protocol/src/client-approvals.mjs'
import { type ApprovalPeer, DeviceApprovals } from '../src/approvals.mjs'
import { answer, card } from './approvals-kit.mjs'
import { FakeClock } from './pair-kit.mjs'

class Peer implements ApprovalPeer {
  readonly got: { method: string; params: any }[] = []
  private readonly declared: boolean
  constructor(declared: boolean) {
    this.declared = declared
  }
  declares(extension: string): boolean {
    return this.declared && extension === 'clientApprovals'
  }
  announce(method: string, params: unknown, extension?: string): void {
    if (extension === undefined || this.declares(extension)) this.got.push({ method, params })
  }
}

function rig() {
  const clock = new FakeClock()
  const changed: { threadId: string; data: any[] }[] = []
  const approvals = new DeviceApprovals(
    {
      announce: (method, params, extension) => {
        assert.equal(method, 'litch/approval/changed')
        assert.equal(extension, 'clientApprovals')
        changed.push(params as any)
      },
      log: () => {},
    },
    clock,
  )
  const fails = (peer: ApprovalPeer, method: string, params: unknown) => {
    try {
      approvals.call(peer, method, params)
    } catch (error) {
      return error as { code: number; data?: { reason: string } }
    }
    throw new Error(`${method} 应该失败`)
  }
  return { clock, changed, approvals, fails }
}

test('open、list、answer、close：答复只转给发卡片的那条连接，changed 按会话发', () => {
  const r = rig()
  const desktop = new Peer(true)
  const phone = new Peer(true)
  assert.deepEqual(r.approvals.call(desktop, 'litch/approval/open', card()), {})
  assert.deepEqual(r.changed.at(-1)?.threadId, 'thread-1')
  assert.equal(r.changed.at(-1)?.data.length, 1)
  const listed = r.approvals.call(phone, 'litch/approval/list', {}) as { data: any[] }
  assert.equal(listed.data.length, 1)
  assert.equal(listed.data[0].openedAt, r.clock.now())
  assert.equal(listed.data[0].summary.accounts[0].masked, 'so•••@gmail.com')
  assert.deepEqual(r.approvals.call(phone, 'litch/approval/list', { threadId: 'other' }), {
    data: [],
  })
  // 多带的键不转
  r.approvals.call(phone, 'litch/approval/answer', {
    ...answer(),
    extra: 'x',
    phoneName: 'Pixel\n8',
  })
  assert.deepEqual(desktop.got, [
    { method: 'litch/approval/answered', params: { ...answer(), phoneName: 'Pixel 8' } },
  ])
  assert.equal(phone.got.length, 0)
  // 答过了卡片照样挂着，等桌面端自己收
  assert.equal((r.approvals.call(phone, 'litch/approval/list', {}) as any).data.length, 1)
  // 别的连接收不掉
  r.approvals.call(phone, 'litch/approval/close', { id: card().id })
  assert.equal((r.approvals.call(phone, 'litch/approval/list', {}) as any).data.length, 1)
  r.approvals.call(desktop, 'litch/approval/close', { id: card().id })
  assert.deepEqual(r.changed.at(-1), { threadId: 'thread-1', data: [] })
  const gone = r.fails(phone, 'litch/approval/answer', answer())
  assert.deepEqual([gone.code, gone.data], [-32602, { reason: 'unknownApproval' }])
})

test('没声明的连接不能挂卡片；别的连接用过的号回 duplicate；同一条再开是换内容', () => {
  const r = rig()
  const desktop = new Peer(true)
  const other = new Peer(true)
  const undeclared = r.fails(new Peer(false), 'litch/approval/open', card())
  assert.deepEqual([undeclared.code, undeclared.data], [-32000, { reason: 'undeclared' }])
  r.approvals.call(desktop, 'litch/approval/open', card())
  const duplicate = r.fails(other, 'litch/approval/open', card())
  assert.deepEqual(duplicate.data, { reason: 'duplicate' })
  const openedAt = r.clock.now()
  r.clock.advance(1000)
  r.approvals.call(desktop, 'litch/approval/open', card({ threadId: 'thread-2' }))
  // 原来的会话上没了，新会话上有，openedAt 不变
  assert.deepEqual(r.changed.at(-2), { threadId: 'thread-1', data: [] })
  assert.equal(r.changed.at(-1)?.threadId, 'thread-2')
  assert.equal(r.changed.at(-1)?.data[0].openedAt, openedAt)
})

test('形状不对回 -32602：卡片号太短、源不是 http(s)、账号重复；答复里拒绝带了账号、账号不在卡片上', () => {
  const r = rig()
  const desktop = new Peer(true)
  const shapes: unknown[] = [
    card({ id: 'short' }),
    card({ summary: { ...card().summary, origin: 'javascript:alert(1)' } }),
    card({
      summary: {
        ...card().summary,
        accounts: [
          { ref: 'a1', masked: 'x' },
          { ref: 'a1', masked: 'y' },
        ],
      },
    }),
    { ...card(), kind: 'site' },
  ]
  for (const shape of shapes) {
    const failure = r.fails(desktop, 'litch/approval/open', shape)
    assert.deepEqual([failure.code, failure.data], [-32602, undefined])
  }
  r.approvals.call(desktop, 'litch/approval/open', card())
  for (const bad of [
    answer({ decision: 'decline' }),
    answer({ ref: null }),
    answer({ decision: 'decline', ref: null, remember: true }),
    answer({ approvalKey: 'short' }),
    answer({ signature: 'short' }),
    answer({ phoneId: 'NOT-HEX' }),
  ]) {
    const failure = r.fails(desktop, 'litch/approval/answer', bad)
    assert.equal(failure.code, -32602, JSON.stringify(bad))
  }
  assert.equal(r.fails(desktop, 'litch/approval/answer', answer({ ref: 'zz' })).code, -32602)
  r.approvals.call(desktop, 'litch/approval/answer', answer({ decision: 'decline', ref: null }))
  assert.equal(desktop.got.length, 1)
})

test('文字去掉控制字符并截断', () => {
  const r = rig()
  const desktop = new Peer(true)
  r.approvals.call(
    desktop,
    'litch/approval/open',
    card({ summary: { ...card().summary, reason: `a\u0007b‮c${'x'.repeat(2000)}` } }),
  )
  const reason = (r.approvals.call(desktop, 'litch/approval/list', {}) as any).data[0].summary
    .reason as string
  assert.equal(reason.length, 1000)
  assert.ok(reason.startsWith('a b c'))
})

test('过期收掉；已经过期的不让开；答太多次回 tooMany；一条连接挂太多回 tooMany', () => {
  const r = rig()
  const desktop = new Peer(true)
  const expired = r.fails(desktop, 'litch/approval/open', card({ expiresAt: r.clock.now() }))
  assert.deepEqual(expired.data, { reason: 'expired' })
  r.approvals.call(desktop, 'litch/approval/open', card({ expiresAt: r.clock.now() + 60_000 }))
  for (let i = 0; i < APPROVAL_ANSWERS_MAX; i++)
    r.approvals.call(desktop, 'litch/approval/answer', answer())
  assert.deepEqual(r.fails(desktop, 'litch/approval/answer', answer()).data, { reason: 'tooMany' })
  r.clock.advance(60_000)
  assert.deepEqual(r.changed.at(-1), { threadId: 'thread-1', data: [] })
  for (let i = 0; i < APPROVAL_MAX_PER_CONNECTION; i++)
    r.approvals.call(
      desktop,
      'litch/approval/open',
      card({ id: `card-${String(i).padStart(12, '0')}` }),
    )
  assert.deepEqual(
    r.fails(desktop, 'litch/approval/open', card({ id: 'one-more-card-000' })).data,
    { reason: 'tooMany' },
  )
  // 别的连接不受影响
  r.approvals.call(new Peer(true), 'litch/approval/open', card({ id: 'one-more-card-000' }))
})

test('连接断了：它挂的卡片都收掉，别的连接的留着', () => {
  const r = rig()
  const desktop = new Peer(true)
  const other = new Peer(true)
  r.approvals.call(desktop, 'litch/approval/open', card())
  r.approvals.call(other, 'litch/approval/open', card({ id: 'another-card-0001', threadId: 't2' }))
  r.approvals.left(desktop)
  const listed = r.approvals.call(other, 'litch/approval/list', {}) as { data: any[] }
  assert.deepEqual(
    listed.data.map((item) => item.id),
    ['another-card-0001'],
  )
  assert.deepEqual(r.changed.at(-1), { threadId: 'thread-1', data: [] })
})
