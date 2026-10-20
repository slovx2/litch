// 建议任务（提案卡片）在设备进程里的行为：模型的 accept、withdraw，提案的门槛，提案记下的回合、调用与了结时间，
// 列表带了结的，用户开始时改参数（overrides），变更通知带刚变的那几条。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOL_LIMITS } from '../../protocol/src/client-tools-sessions.mjs'
import { SESSION_TREE_LIMITS } from '../../protocol/src/session-tree.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import type { TestClient } from './helpers.mjs'
import {
  brief,
  got,
  litch,
  parent,
  SESSIONS,
  startedOn,
  type TreeEnv,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

const PROPOSALS = 'litch/sessionProposal/changed'

/** 模型在 pi 的父会话里提一张提案，返回 proposal_id */
async function propose(env: TreeEnv, threadId: string, title: string, more = {}): Promise<string> {
  const answer = (
    await env.pi.callTool(threadId, SESSIONS, 'start', {
      title,
      prompt: brief(title),
      ...more,
    })
  )?.answer
  return resultOf(answer).proposal_id as string
}

/** 父会话这一回合结束，用户再说一句（新的用户回合） */
async function nextUserTurn(env: TreeEnv, client: TestClient, threadId: string): Promise<string> {
  env.pi.end(threadId)
  await until(() => !env.device.sessionTree.isActive(threadId), '上一回合结束')
  const turn = await client.call('turn/start', { threadId, input: text('开始第一个') })
  return turn.turn.id as string
}

test('SESSION-PROPOSALS-001：模型的 accept 只在用户回合里、只对自己的提案，按提案原样起，提案标 started', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const proposalId = await propose(env, threadId, '整理日志', { harness: 'claude-code' })
    // 引擎自己续跑的回合：不算用户让开始的
    env.pi.end(threadId)
    env.pi.selfTurn(threadId)
    const refused = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: proposalId,
    })
    assert.equal(failureOf(refused?.answer), 'blocked')
    assert.match(refused?.answer.result.contentItems[0].text, /start it from the card/)
    assert.equal(env.claude.sent('thread/start').length, 0)
    await nextUserTurn(env, client, threadId)
    // 别的会话的提案、没有的提案
    const stranger = (await client.call('thread/start', { harness: 'pi', cwd: '/x' })).thread.id
    await client.call('turn/start', { threadId: stranger, input: text('嗨') })
    const foreign = await env.pi.callTool(stranger, SESSIONS, 'accept', { proposal_id: proposalId })
    assert.equal(failureOf(foreign?.answer), 'blocked')
    const missing = await env.pi.callTool(threadId, SESSIONS, 'accept', { proposal_id: 'nope' })
    assert.equal(failureOf(missing?.answer), 'invalid')
    const started = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'accept', { proposal_id: proposalId }))?.answer,
    )
    assert.equal(started.thread_id, 'claude-code-t1')
    assert.match(started.note, /from the proposal/)
    const born = await startedOn(client, started.thread_id)
    assert.equal(born.params.thread.litchLineage.origin, 'proposal')
    assert.equal(born.params.thread.litchLineage.proposalId, proposalId)
    const [brief0] = env.claude.sent('turn/start')
    assert.match(brief0.input[0].text, /Task: 整理日志/)
    const stored = env.device.sessionTree.store.proposal(proposalId)
    assert.equal(stored?.status, 'started')
    assert.equal(stored?.startedThreadId, started.thread_id)
    assert.ok(typeof stored?.settledAt === 'number' && stored.settledAt > 0)
    // 已经开始了：照实回，不再起一个
    const again = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'accept', { proposal_id: proposalId }))?.answer,
    )
    assert.equal(again.thread_id, started.thread_id)
    assert.match(again.note, /already started/)
    assert.equal(env.claude.sent('thread/start').length, 1)
    // 不要了的：回 invalid，说明里让模型直接起
    const other = await propose(env, threadId, '另一件事')
    await client.call('litch/sessionProposal/dismiss', { proposalId: other })
    const late = await env.pi.callTool(threadId, SESSIONS, 'accept', { proposal_id: other })
    assert.equal(failureOf(late?.answer), 'invalid')
    assert.match(late?.answer.result.contentItems[0].text, /dismissed.*user_asked/)
  } finally {
    await env.close()
  }
})

test('SESSION-PROPOSALS-002：带 widerSandbox 的提案模型不能 accept，只能用户从卡片开始', async () => {
  const env = treeRig()
  try {
    env.claude.declaration = {
      extensions: ['clientTools'],
      permissionPresets: [{ id: ':danger-full-access' }],
    }
    const client = await litch(env)
    const { threadId } = await parent(client)
    const proposalId = await propose(env, threadId, '没沙箱的', { harness: 'claude-code' })
    const refused = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: proposalId,
    })
    assert.equal(failureOf(refused?.answer), 'blocked')
    assert.match(refused?.answer.result.contentItems[0].text, /wider sandbox/)
    assert.equal(env.device.sessionTree.store.proposal(proposalId)?.status, 'pending')
  } finally {
    await env.close()
  }
})

test('SESSION-PROPOSALS-003：withdraw 只撤自己的；pending 标 withdrawn，开始了、不要了、过期了照实回', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await propose(env, threadId, '第一件')
    const second = await propose(env, threadId, '第二件')
    const third = await propose(env, threadId, '第三件')
    const before = got(client, PROPOSALS).length
    const withdrawn = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: first }))?.answer,
    )
    assert.equal(withdrawn.status, 'withdrawn')
    await until(() => got(client, PROPOSALS).length > before, '撤回要通知')
    const note = got(client, PROPOSALS).at(-1)
    assert.deepEqual(
      note.changed.map((one: any) => [one.id, one.status]),
      [[first, 'withdrawn']],
    )
    assert.ok(note.changed[0].settledAt > 0)
    assert.deepEqual(
      note.proposals.map((one: any) => one.id),
      [second, third],
    )
    // 撤回过的再撤一次：照实回 withdrawn，不报错
    const twice = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: first }))?.answer,
    )
    assert.equal(twice.status, 'withdrawn')
    // 撤回了的不能再开始
    const late = await client.fails('litch/sessionProposal/accept', { proposalId: first })
    assert.match(late.message, /撤回了/)
    const { threadId: childId } = await client.call('litch/sessionProposal/accept', {
      proposalId: second,
    })
    const started = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: second }))?.answer,
    )
    assert.deepEqual([started.status, started.thread_id], ['started', childId])
    await client.call('litch/sessionProposal/dismiss', { proposalId: third })
    const dismissed = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: third }))?.answer,
    )
    assert.equal(dismissed.status, 'dismissed')
    env.device.sessionTree.store.addProposal({
      id: 'old',
      threadId,
      title: '早就过期',
      prompt: 'x',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      createdAt: 1,
      expiresAt: 2,
    })
    const expired = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: 'old' }))?.answer,
    )
    assert.equal(expired.status, 'expired')
    // 别人的、没有的
    const stranger = (await client.call('thread/start', { harness: 'pi', cwd: '/x' })).thread.id
    await client.call('turn/start', { threadId: stranger, input: text('嗨') })
    const mine = await propose(env, threadId, '第四件')
    const foreign = await env.pi.callTool(stranger, SESSIONS, 'withdraw', { proposal_id: mine })
    assert.equal(failureOf(foreign?.answer), 'blocked')
    assert.equal(env.device.sessionTree.store.proposal(mine)?.status, 'pending')
    const missing = await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: 'nope' })
    assert.equal(failureOf(missing?.answer), 'invalid')
  } finally {
    await env.close()
  }
})

test('SESSION-PROPOSALS-004：门槛：一回合最多几张（撤回的也算）、pending 的不能同标题、fresh 简报太短都拒绝', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const ids: string[] = []
    for (let n = 1; n <= SESSION_TOOL_LIMITS.proposalsPerTurn; n++)
      ids.push(await propose(env, threadId, `活 ${n}`))
    await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: ids[0] })
    const full = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '再来一张',
      prompt: brief('再来一张'),
    })
    assert.equal(failureOf(full?.answer), 'blocked')
    assert.match(full?.answer.result.contentItems[0].text, /mention them in your reply/)
    // 直接起的不算提案，不受这个限制
    const direct = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '用户要的',
          prompt: brief('用户要的'),
          initiation: 'user_asked',
        })
      )?.answer,
    )
    assert.ok(direct.thread_id)
    // 下一回合重新算；同标题（去空白、不分大小写）的 pending 提案拒绝
    await nextUserTurn(env, client, threadId)
    const twin = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: ' 活2 ',
      prompt: brief('同一件'),
    })
    assert.equal(failureOf(twin?.answer), 'invalid')
    assert.match(twin?.answer.result.contentItems[0].text, new RegExp(`${ids[1]}.*withdraw`))
    const upper = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: 'Fix  Build',
      prompt: brief('a'),
    })
    resultOf(upper?.answer)
    const lower = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: 'fix build',
      prompt: brief('b'),
    })
    assert.equal(failureOf(lower?.answer), 'invalid')
    // 撤回了的标题可以再用
    const reused = await propose(env, threadId, '活 1')
    assert.ok(reused)
    // fresh 的简报太短：提案、直接起都拒绝；fork 不查
    const short = 'x'.repeat(SESSION_TOOL_LIMITS.freshPromptMinWidth - 1)
    for (const initiation of ['propose', 'user_asked']) {
      const refused = await env.pi.callTool(threadId, SESSIONS, 'start', {
        title: `短的 ${initiation}`,
        prompt: `  ${short}  `,
        initiation,
      })
      assert.equal(failureOf(refused?.answer), 'invalid', initiation)
      assert.match(refused?.answer.result.contentItems[0].text, /too short \(79 characters\)/)
    }
    const fork = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '分叉',
          prompt: '换个办法。',
          kind: 'fork',
          initiation: 'user_asked',
        })
      )?.answer,
    )
    assert.ok(fork.thread_id)
    const enough = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '刚好够',
      prompt: '字'.repeat(SESSION_TOOL_LIMITS.freshPromptMinWidth),
    })
    assert.ok(resultOf(enough?.answer).proposal_id)
  } finally {
    await env.close()
  }
})

test('SESSION-PROPOSALS-005：提案记下回合与调用；列表 includeSettled 带了结的、新的在前、有上限；变更通知带 changed', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    const before = got(client, PROPOSALS).length
    const first = await propose(env, threadId, '第一件')
    await until(() => got(client, PROPOSALS).length > before, '新提要通知')
    const added = got(client, PROPOSALS).at(-1)
    assert.deepEqual(
      added.changed.map((one: any) => [one.id, one.status, one.settledAt]),
      [[first, 'pending', null]],
    )
    const stored = env.device.sessionTree.store.proposal(first)
    assert.equal(stored?.turnId, turnId)
    assert.match(String(stored?.callId), /^call-req-\d+$/)
    const second = await propose(env, threadId, '第二件')
    await client.call('litch/sessionProposal/dismiss', { proposalId: first })
    const pendingOnly = await client.call('litch/sessionProposal/list', { threadId })
    assert.deepEqual(
      pendingOnly.proposals.map((one: any) => one.id),
      [second],
    )
    const all = await client.call('litch/sessionProposal/list', { threadId, includeSettled: true })
    assert.deepEqual(
      all.proposals.map((one: any) => [one.id, one.status]),
      [
        [second, 'pending'],
        [first, 'dismissed'],
      ],
    )
    assert.ok(all.proposals[1].settledAt > 0)
    assert.equal(all.proposals[0].turnId, turnId)
    // 上限：库里塞一批旧的
    const store = env.device.sessionTree.store
    for (let n = 0; n < SESSION_TREE_LIMITS.proposalListMax + 5; n++)
      store.addProposal({
        id: `bulk-${n}`,
        threadId,
        title: `旧 ${n}`,
        prompt: 'x',
        harness: null,
        model: null,
        cwd: null,
        kind: 'fresh',
        wakeParent: true,
        createdAt: 1000 + n,
        expiresAt: 4_000_000_000,
      })
    const capped = await client.call('litch/sessionProposal/list', {
      threadId,
      includeSettled: true,
    })
    assert.equal(capped.proposals.length, SESSION_TREE_LIMITS.proposalListMax)
    assert.deepEqual(
      capped.proposals.slice(0, 2).map((one: any) => one.id),
      [second, first],
    )
    assert.equal(capped.proposals.at(-1).id, 'bulk-7', '最旧的几条掉出去')
    // 到期的同一会话一次收掉，changed 里放在一起
    store.addProposal({ ...bulkOf(threadId, 'gone-1'), expiresAt: 2 })
    store.addProposal({ ...bulkOf(threadId, 'gone-2'), expiresAt: 3 })
    const mark = got(client, PROPOSALS).length
    await client.call('litch/sessionProposal/list', { threadId })
    await until(() => got(client, PROPOSALS).length > mark, '过期要通知')
    const expired = got(client, PROPOSALS).at(-1)
    assert.deepEqual(expired.changed.map((one: any) => [one.id, one.status]).sort(), [
      ['gone-1', 'expired'],
      ['gone-2', 'expired'],
    ])
  } finally {
    await env.close()
  }
})

function bulkOf(threadId: string, id: string) {
  return {
    id,
    threadId,
    title: id,
    prompt: 'x',
    harness: null,
    model: null,
    cwd: null,
    kind: 'fresh' as const,
    wakeParent: true,
    createdAt: 1,
    expiresAt: 2,
  }
}

test('SESSION-PROPOSALS-006：用户开始时可改 harness、模型、强度、目录、标题、简报、权限；沙箱照旧收紧；改成 fork 要同 harness', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const proposalId = await propose(env, threadId, '原来的标题', {
      harness: 'claude-code',
      model: 'big',
    })
    // 改成 fork 但 harness 还是提案里的 claude-code：不行
    const fork = await client.fails('litch/sessionProposal/accept', {
      proposalId,
      overrides: { kind: 'fork' },
    })
    assert.equal(fork.code, -32602)
    assert.match(fork.message, /same harness/)
    const badType = await client.fails('litch/sessionProposal/accept', {
      proposalId,
      overrides: { model: 3 },
    })
    assert.equal(badType.code, -32602)
    const emptyTitle = await client.fails('litch/sessionProposal/accept', {
      proposalId,
      overrides: { title: '  ' },
    })
    assert.equal(emptyTitle.code, -32602)
    assert.equal(env.device.sessionTree.store.proposal(proposalId)?.status, 'pending')
    // 改到 pi（同父会话）、清掉模型、换目录、标题、简报，要更宽的权限
    const { threadId: childId } = await client.call('litch/sessionProposal/accept', {
      proposalId,
      overrides: {
        harness: 'pi',
        model: '',
        effort: 'high',
        cwd: '/work/other',
        title: '改过的标题',
        prompt: '改过的简报',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      },
    })
    const started = env.pi.sent('thread/start').at(-1)
    assert.equal(started.cwd, '/work/other')
    assert.equal(started.model, undefined, '模型清掉了，用缺省')
    assert.equal(started.approvalPolicy, 'on-request', '审批收紧到父会话的')
    assert.equal(started.sandbox, 'workspace-write', '沙箱收紧到父会话的')
    const first = env.pi.sent('turn/start').find((params) => params.threadId === childId)
    assert.equal(first.effort, 'high')
    assert.match(first.input[0].text, /Task: 改过的标题/)
    assert.match(first.input[0].text, /改过的简报/)
    const child = await client.call('thread/read', { threadId: childId })
    assert.deepEqual(
      [
        child.thread.litchLineage.origin,
        child.thread.litchLineage.proposalId,
        child.thread.litchLineage.title,
      ],
      ['proposal', proposalId, '改过的标题'],
    )
    // 不改的照提案：harness、模型都是提案里的
    const plainId = await propose(env, threadId, '照原样', { harness: 'claude-code', model: 'big' })
    await client.call('litch/sessionProposal/accept', { proposalId: plainId })
    assert.equal(env.claude.sent('thread/start').at(-1).model, 'big')
    // 改成 fork、harness 同父会话：可以
    const forkId = await propose(env, threadId, '分叉开始', { harness: 'claude-code' })
    const { threadId: forked } = await client.call('litch/sessionProposal/accept', {
      proposalId: forkId,
      overrides: { kind: 'fork', harness: 'pi' },
    })
    const forkedRead = await client.call('thread/read', { threadId: forked })
    assert.equal(forkedRead.thread.litchLineage.kind, 'fork')
  } finally {
    await env.close()
  }
})

test('SESSION-PROPOSALS-007：用户正在开始一张提案时：再点开始、点不要都回不支持，模型撤回等它起完、答 started', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const proposalId = await propose(env, threadId, '慢慢起', { harness: 'claude-code' })
    // claude-code 建会话先不应答
    const original = env.claude.handlers['thread/start'] as NonNullable<
      (typeof env.claude.handlers)[string]
    >
    let held: { params: any; connection: any; id: unknown } | null = null
    env.claude.handlers['thread/start'] = (params, connection) => {
      held = { params, connection, id: env.claude.seen.at(-1)?.id }
      return undefined
    }
    const accepting = client.call('litch/sessionProposal/accept', { proposalId })
    await until(() => held !== null, '开始走到建会话')
    const dismiss = await client.fails('litch/sessionProposal/dismiss', { proposalId })
    assert.match(dismiss.message, /正在开始/)
    const twice = await client.fails('litch/sessionProposal/accept', { proposalId })
    assert.match(twice.message, /正在开始/)
    const withdrawing = env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: proposalId })
    await new Promise((resolve) => setTimeout(resolve, 50))
    env.claude.handlers['thread/start'] = original
    const pending = held as unknown as { params: any; connection: any; id: unknown }
    pending.connection.send({
      id: pending.id,
      result: original(pending.params, pending.connection),
    })
    const { threadId: childId } = await accepting
    const withdrawn = resultOf((await withdrawing)?.answer)
    assert.deepEqual([withdrawn.status, withdrawn.thread_id], ['started', childId])
    assert.equal(env.device.sessionTree.store.proposal(proposalId)?.status, 'started')
  } finally {
    await env.close()
  }
})
