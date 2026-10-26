// 定时任务回合里要人答的请求（task-approvals.mts）：只接管任务回合里的那几种请求，到时限替人拒绝，
// 有人答了取消计时，设备进程重启后接着等时沿用原来的时限，连接关了收场。这里对着一条假的内部连接测。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskRunApproval } from '../../protocol/src/device-tasks.mjs'
import type { EngineLink } from '../src/engine-link.mjs'
import {
  approvalTitle,
  declineAnswer,
  type GuardedTurn,
  guardApprovals,
} from '../src/task-approvals.mjs'
import type { RpcId } from '../src/wire.mjs'
import { FakeClock } from './task-kit.mjs'

const MINUTE = 60_000

/** 只有 guardApprovals 用到的那几样 */
class FakeLink {
  readonly answers: { id: RpcId; result: unknown }[] = []
  claim: ((method: string, params: any) => boolean) | null = null
  closed = false
  private readonly requested = new Set<(method: string, params: any, id: RpcId) => void>()
  private readonly notified = new Set<(method: string, params: any) => void>()
  private readonly closing = new Set<(reason: string) => void>()

  /** 引擎发来一条请求：先给订阅者看，再问要不要接管（同 engine-link.mts 的顺序） */
  request(method: string, params: any, id: RpcId): boolean {
    for (const listener of [...this.requested]) listener(method, params, id)
    return this.claim?.(method, params) ?? false
  }

  notify(method: string, params: any): void {
    for (const listener of [...this.notified]) listener(method, params)
  }

  close(): void {
    this.closed = true
    for (const listener of [...this.closing]) listener('关了')
  }

  asLink(): EngineLink {
    return {
      harness: 'pi',
      runtime: null,
      native: false,
      closed: false,
      request: async () => ({}),
      onNotification: (listener) => {
        this.notified.add(listener)
        return () => this.notified.delete(listener)
      },
      onServerRequest: (listener) => {
        this.requested.add(listener)
        return () => this.requested.delete(listener)
      },
      onClose: (listener) => {
        this.closing.add(listener)
        return () => this.closing.delete(listener)
      },
      claimRequests: (match) => {
        this.claim = match
      },
      claimed: () => false,
      answer: (id, result) => {
        if (this.closed) return false
        this.answers.push({ id, result })
        return true
      },
      close: () => this.close(),
    }
  }
}

function setup(earlier: TaskRunApproval[] = [], timeoutMinutes = 30) {
  const clock = new FakeClock()
  const link = new FakeLink()
  const changes: TaskRunApproval[][] = []
  const turn: { current: GuardedTurn | null } = { current: { threadId: 't1', turnId: 'u1' } }
  guardApprovals(
    link.asLink(),
    () => turn.current,
    {
      clock,
      timeoutMs: () => timeoutMinutes * MINUTE,
      log: () => {},
      changed: (approvals) => changes.push(approvals),
    },
    earlier,
  )
  return { clock, link, changes, turn, last: () => changes.at(-1) ?? [] }
}

const command = { threadId: 't1', turnId: 'u1', itemId: 'c1', command: 'rm -rf build' }

test('TASK-APPROVAL-001：任务回合里的审批等满时限没人答，按拒绝答复引擎，记成 autoDeclined', () => {
  const { clock, link, last } = setup()
  assert.equal(link.request('item/commandExecution/requestApproval', command, 'r1'), true)
  assert.equal(last().length, 1)
  assert.equal(last()[0]?.state, 'waiting')
  assert.equal(last()[0]?.kind, 'command')
  assert.equal(last()[0]?.title, 'rm -rf build')
  const requestedAt = last()[0]?.requestedAt as number
  assert.equal(last()[0]?.declineAt, requestedAt + 30 * 60)
  clock.advance(29 * MINUTE)
  assert.equal(link.answers.length, 0, '没到时限不答')
  clock.advance(MINUTE)
  assert.deepEqual(link.answers, [{ id: 'r1', result: { decision: 'decline' } }])
  assert.equal(last()[0]?.state, 'autoDeclined')
  assert.ok((last()[0]?.settledAt as number) >= requestedAt + 30 * 60)
  // 引擎随后说这条有结果了：不再改
  const before = last()
  link.notify('serverRequest/resolved', { threadId: 't1', requestId: 'r1' })
  assert.deepEqual(last(), before)
})

test('TASK-APPROVAL-002：中途有人答了（引擎发 serverRequest/resolved），取消计时，记成 resolved', () => {
  const { clock, link, last } = setup()
  link.request('item/fileChange/requestApproval', { ...command, reason: '改配置' }, 7)
  assert.equal(clock.pending().length, 1)
  link.notify('serverRequest/resolved', { threadId: 't1', requestId: 7 })
  assert.equal(last()[0]?.state, 'resolved')
  assert.equal(clock.pending().length, 0)
  clock.advance(60 * MINUTE)
  assert.equal(link.answers.length, 0)
})

test('TASK-APPROVAL-003：只接管任务回合里的那几种请求；别的回合、客户端工具调用照原来的做法', () => {
  const { link, changes, turn } = setup()
  assert.equal(
    link.request('item/commandExecution/requestApproval', { ...command, turnId: 'other' }, 'a'),
    false,
  )
  assert.equal(
    link.request('item/commandExecution/requestApproval', { ...command, threadId: 't2' }, 'b'),
    false,
  )
  assert.equal(
    link.request(
      'item/tool/call',
      { threadId: 't1', turnId: 'u1', namespace: 'litch_browser' },
      'c',
    ),
    false,
  )
  assert.equal(link.request('constructor', { threadId: 't1', turnId: 'u1' }, 'd'), false)
  // MCP 征询可以不带回合号
  assert.equal(
    link.request(
      'mcpServer/elicitation/request',
      { threadId: 't1', turnId: null, serverName: 'docs', mode: 'form', message: '要登录' },
      'e',
    ),
    true,
  )
  assert.equal(changes.at(-1)?.length, 1)
  assert.equal(changes.at(-1)?.[0]?.title, 'docs: 要登录')
  // 任务回合结束了（跟着后台任务续跑的那段）：不再接管
  turn.current = null
  assert.equal(link.request('item/commandExecution/requestApproval', command, 'f'), false)
  assert.equal(changes.at(-1)?.length, 1)
})

test('TASK-APPROVAL-004：设备进程重启后接着等，引擎重放同一条时沿用原来的时限；没再收到的、连接关时还在等的记成 resolved', () => {
  const clock = new FakeClock()
  const nowSeconds = Math.floor(clock.now() / 1000)
  const earlier: TaskRunApproval[] = [
    {
      requestId: 'r1',
      kind: 'command',
      title: 'rm -rf build',
      requestedAt: nowSeconds - 20 * 60,
      declineAt: nowSeconds + 10 * 60,
      state: 'waiting',
      settledAt: null,
    },
    {
      requestId: 'r2',
      kind: 'question',
      title: '用哪个分支？',
      requestedAt: nowSeconds - 20 * 60,
      declineAt: nowSeconds + 10 * 60,
      state: 'waiting',
      settledAt: null,
    },
  ]
  const link = new FakeLink()
  const changes: TaskRunApproval[][] = []
  guardApprovals(
    link.asLink(),
    () => ({ threadId: 't1', turnId: 'u1' }),
    { clock, timeoutMs: () => 30 * MINUTE, log: () => {}, changed: (list) => changes.push(list) },
    earlier,
  )
  link.request('item/commandExecution/requestApproval', command, 'r1')
  assert.equal(changes.length, 0, '重放的不算新的一条')
  assert.ok((clock.pending()[0] as number) <= 10 * MINUTE)
  clock.advance(10 * MINUTE)
  assert.deepEqual(link.answers, [{ id: 'r1', result: { decision: 'decline' } }])
  assert.equal(changes.at(-1)?.[0]?.state, 'autoDeclined')
  assert.equal(changes.at(-1)?.[1]?.state, 'waiting')
  link.close()
  assert.equal(changes.at(-1)?.[1]?.state, 'resolved')
})

test('TASK-APPROVAL-005：拒绝的答复和一句话按种类给；连接断了答不出去的记 resolved', () => {
  assert.deepEqual(declineAnswer('permissions', {}), { permissions: {}, scope: 'turn' })
  assert.deepEqual(declineAnswer('question', { questions: [{ id: 'q1' }, { id: 'q2' }] }), {
    answers: { q1: { answers: [] }, q2: { answers: [] } },
  })
  assert.deepEqual(declineAnswer('elicitation', {}), {
    action: 'decline',
    content: null,
    _meta: null,
  })
  assert.equal(
    approvalTitle('permissions', {
      permissions: { network: { enabled: true }, fileSystem: { write: ['/srv'] } },
    }),
    'network, write /srv',
  )
  assert.equal(
    approvalTitle('question', { questions: [{ header: '分支', question: '用哪个分支？' }] }),
    '用哪个分支？',
  )
  assert.equal(Array.from(approvalTitle('command', { command: 'x'.repeat(500) })).length, 200)

  const { clock, link, last } = setup([], 1)
  link.request('item/permissions/requestApproval', { ...command, permissions: {} }, 'p')
  link.closed = true
  clock.advance(MINUTE)
  assert.equal(last()[0]?.state, 'resolved')
})
