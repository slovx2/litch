// offer 卡（litch_sessions.start 的 initiation offer）在设备进程里的行为：只带标题落一张 offered 的卡、调用一直等；
// 用户在卡上选（litch/sessionProposal/answer）、又发了话、打断、回合结束都让它了结；选了新会话的由模型 accept 补简报开起来；
// 设备进程重启时还在等的当作在这里做。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import test from 'node:test'
import { SESSION_TOOL_LIMITS } from '../../protocol/src/client-tools-sessions.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { SessionTree } from '../src/session-tree.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { tempDir } from './helpers.mjs'
import {
  brief,
  got,
  litch,
  parent,
  plain,
  SESSIONS,
  startedOn,
  type TreeEnv,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

const CHANGED = 'litch/sessionProposal/changed'

/** 模型在会话的当前回合里调一次 start(offer)，不等结果；等到卡落下，返回提案号和那次调用 */
async function offer(env: TreeEnv, threadId: string, title: string, more: object = {}) {
  const before = new Set(env.device.sessionTree.proposals(threadId).map((one) => one.id))
  const call = env.pi.callTool(threadId, SESSIONS, 'start', {
    title,
    initiation: 'offer',
    ...more,
  })
  let proposalId = ''
  await until(() => {
    const fresh = env.device.sessionTree.proposals(threadId).find((one) => !before.has(one.id))
    proposalId = fresh?.id ?? ''
    return proposalId !== ''
  }, 'offer 卡落下')
  return { proposalId, call }
}

const answerOf = async (call: Promise<{ answer: any } | null>) => (await call)?.answer

test('OFFER-001：用户选新会话：卡从 offered 到 chosen，调用回 choice=session；accept 必须带够宽的简报，起子会话、卡标 started', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    const { proposalId, call } = await offer(env, threadId, '整理发布脚本')
    const stored = env.device.sessionTree.store.proposal(proposalId)
    assert.equal(stored?.status, 'offered')
    assert.equal(stored?.offer, true)
    assert.equal(stored?.prompt, '')
    assert.equal(stored?.turnId, turnId)
    assert.match(String(stored?.callId), /^call-req-\d+$/)
    // 等着的卡照常列出来、照常通知
    const listed = await client.call('litch/sessionProposal/list', { threadId })
    assert.deepEqual(
      listed.proposals.map((one: any) => [one.id, one.status, one.offer]),
      [[proposalId, 'offered', true]],
    )
    await until(() => got(client, CHANGED).length >= 1, '收到落卡的通知')
    assert.equal(got(client, CHANGED)[0].changed[0].status, 'offered')
    // 用户选了新会话
    assert.deepEqual(
      await client.call('litch/sessionProposal/answer', { proposalId, choice: 'session' }),
      {},
    )
    const result = resultOf(await answerOf(call))
    assert.equal(result.proposal_id, proposalId)
    assert.equal(result.choice, 'session')
    assert.match(result.note, /call litch_sessions\.accept with proposal_id .* full brief/)
    const chosen = env.device.sessionTree.store.proposal(proposalId)
    assert.equal(chosen?.status, 'chosen')
    assert.equal(chosen?.settledAt, null, 'chosen 还没了结')
    await until(
      () => got(client, CHANGED).some((one) => one.changed[0].status === 'chosen'),
      'chosen 的通知',
    )
    const changed = got(client, CHANGED).find((one) => one.changed[0].status === 'chosen')
    assert.deepEqual(
      changed.proposals.map((one: any) => one.status),
      ['chosen'],
      'proposals 里带着还在等简报的',
    )
    // 答过的不能再答
    const twice = await client.fails('litch/sessionProposal/answer', { proposalId, choice: 'here' })
    assert.match(twice.message, /已经选了新会话/)
    // accept：不带简报、简报太短都不收
    const bare = await env.pi.callTool(threadId, SESSIONS, 'accept', { proposal_id: proposalId })
    assert.equal(failureOf(bare?.answer), 'invalid')
    assert.match(bare?.answer.result.contentItems[0].text, /prompt is required/)
    const short = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: proposalId,
      prompt: '整理一下',
    })
    assert.equal(failureOf(short?.answer), 'invalid')
    assert.match(short?.answer.result.contentItems[0].text, /too short/)
    // 带上简报、换个标题、换到 claude-code：起子会话
    const started = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'accept', {
          proposal_id: proposalId,
          prompt: brief('整理 scripts 下的发布脚本。'),
          title: '整理发布脚本（含说明）',
          harness: 'claude-code',
        })
      )?.answer,
    )
    assert.equal(started.thread_id, 'claude-code-t1')
    assert.match(started.note, /Started sub-session claude-code-t1 on claude-code/)
    const born = await startedOn(client, started.thread_id)
    assert.equal(born.params.thread.litchLineage.origin, 'proposal')
    assert.equal(born.params.thread.litchLineage.proposalId, proposalId)
    assert.equal(born.params.thread.litchLineage.title, '整理发布脚本（含说明）')
    const [first] = env.claude.sent('turn/start')
    assert.match(first.input[0].text, /Task: 整理发布脚本（含说明）/)
    assert.match(first.input[0].text, /整理 scripts 下的发布脚本/)
    const done = env.device.sessionTree.store.proposal(proposalId)
    assert.equal(done?.status, 'started')
    assert.equal(done?.startedThreadId, started.thread_id)
    assert.ok(typeof done?.settledAt === 'number')
    // 再 accept 一次：照实回，不再起
    const again = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'accept', { proposal_id: proposalId }))?.answer,
    )
    assert.equal(again.thread_id, started.thread_id)
    assert.match(again.note, /already started/)
  } finally {
    await env.close()
  }
})

test('OFFER-002：用户选在这里做：卡了结成 here，调用回 choice=here；here 的卡不能 accept、不能撤回', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const { proposalId, call } = await offer(env, threadId, '查一下慢查询')
    await client.call('litch/sessionProposal/answer', { proposalId, choice: 'here' })
    const result = resultOf(await answerOf(call))
    assert.equal(result.choice, 'here')
    assert.match(result.note, /chose to do "查一下慢查询" here/)
    const stored = env.device.sessionTree.store.proposal(proposalId)
    assert.equal(stored?.status, 'here')
    assert.ok(typeof stored?.settledAt === 'number')
    assert.deepEqual(env.device.sessionTree.proposals(threadId), [], '了结了，不在等着的里面')
    const accept = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: proposalId,
      prompt: brief('查慢查询。'),
    })
    assert.equal(failureOf(accept?.answer), 'invalid')
    assert.match(accept?.answer.result.contentItems[0].text, /chose to do it here/)
    const withdraw = await env.pi.callTool(threadId, SESSIONS, 'withdraw', {
      proposal_id: proposalId,
    })
    assert.equal(failureOf(withdraw?.answer), 'invalid')
    assert.equal(env.pi.sent('thread/start').length, 1, '没有起子会话')
  } finally {
    await env.close()
  }
})

test('OFFER-003：没选就插话（turn/steer）、新发 turn/start、打断，都当作在这里做', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    // 插话
    const steered = await offer(env, threadId, '写周报')
    await client.call('turn/steer', { threadId, input: text('先别管了'), expectedTurnId: turnId })
    const spoke = resultOf(await answerOf(steered.call))
    assert.equal(spoke.choice, 'here')
    assert.match(spoke.note, /sent a new message instead of choosing/)
    assert.equal(env.device.sessionTree.store.proposal(steered.proposalId)?.status, 'here')
    // 回合在跑时又发 turn/start（假引擎拒绝，但用户确实说了话）
    const restarted = await offer(env, threadId, '写月报')
    await client.fails('turn/start', { threadId, input: text('换个话题') })
    assert.equal(resultOf(await answerOf(restarted.call)).choice, 'here')
    assert.equal(env.device.sessionTree.store.proposal(restarted.proposalId)?.status, 'here')
    // 打断
    const stopped = await offer(env, threadId, '写年报')
    await client.call('turn/interrupt', { threadId, turnId })
    const interrupted = resultOf(await answerOf(stopped.call))
    assert.equal(interrupted.choice, 'here')
    assert.match(interrupted.note, /interrupted the turn/)
    assert.equal(env.device.sessionTree.store.proposal(stopped.proposalId)?.status, 'here')
  } finally {
    await env.close()
  }
})

test('OFFER-004：回合结束时还在等的、选了新会话却没补简报的，都当作在这里做', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const first = await parent(client)
    const waiting = await offer(env, first.threadId, '迁移数据库')
    env.pi.end(first.threadId)
    const ended = resultOf(await answerOf(waiting.call))
    assert.equal(ended.choice, 'here')
    assert.match(ended.note, /turn ended before the user chose/)
    assert.equal(env.device.sessionTree.store.proposal(waiting.proposalId)?.status, 'here')
    // 选了新会话，模型到回合结束都没 accept
    const turn = await client.call('turn/start', {
      threadId: first.threadId,
      input: text('另一件事'),
    })
    assert.ok(turn.turn.id)
    const chosen = await offer(env, first.threadId, '升级依赖')
    await client.call('litch/sessionProposal/answer', {
      proposalId: chosen.proposalId,
      choice: 'session',
    })
    assert.equal(resultOf(await answerOf(chosen.call)).choice, 'session')
    env.pi.end(first.threadId)
    await until(
      () => env.device.sessionTree.store.proposal(chosen.proposalId)?.status === 'here',
      'chosen 的卡回合结束后当作在这里做',
    )
    await until(
      () =>
        got(client, CHANGED).some(
          (one) => one.changed[0].id === chosen.proposalId && one.changed[0].status === 'here',
        ),
      '收到 here 的通知',
    )
  } finally {
    await env.close()
  }
})

test('OFFER-005：offer 只收用户发起的回合、只要标题、算进一回合的上限；answer 的参数、对象、连接都查', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    // 带了 prompt：不收
    const withPrompt = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '多带了简报',
      prompt: brief('做点事。'),
      initiation: 'offer',
    })
    assert.equal(failureOf(withPrompt?.answer), 'invalid')
    assert.match(withPrompt?.answer.result.contentItems[0].text, /title only/)
    // 普通提案的 accept 带简报字段：不收
    const normal = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '普通提案',
          prompt: brief('普通提案。'),
        })
      )?.answer,
    )
    const extra = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: normal.proposal_id,
      prompt: brief('改一下简报。'),
    })
    assert.equal(failureOf(extra?.answer), 'invalid')
    assert.match(extra?.answer.result.contentItems[0].text, /only for an offer/)
    // 普通提案不能答
    const notOffer = await client.fails('litch/sessionProposal/answer', {
      proposalId: normal.proposal_id,
      choice: 'session',
    })
    assert.match(notOffer.message, /不是“新会话 \/ 在这里做”的卡/)
    // 一回合四张：offer 也算
    const waits = []
    for (const title of ['甲', '乙', '丙']) waits.push(await offer(env, threadId, title))
    assert.equal(
      env.device.sessionTree.proposalsInTurn(threadId, env.pi.current(threadId)?.id ?? ''),
      SESSION_TOOL_LIMITS.proposalsPerTurn,
    )
    const full = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '丁',
      initiation: 'offer',
    })
    assert.equal(failureOf(full?.answer), 'blocked')
    // 同标题还在等的：不收
    const twin = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: ' 甲 ',
      initiation: 'offer',
    })
    assert.equal(failureOf(twin?.answer), 'blocked', '先撞上的是上限')
    // answer 的参数
    const [甲] = waits
    assert.ok(甲)
    const noChoice = await client.fails('litch/sessionProposal/answer', {
      proposalId: 甲.proposalId,
    })
    assert.equal(noChoice.code, -32602)
    const badChoice = await client.fails('litch/sessionProposal/answer', {
      proposalId: 甲.proposalId,
      choice: 'later',
    })
    assert.equal(badChoice.code, -32602)
    const missing = await client.fails('litch/sessionProposal/answer', {
      proposalId: 'nope',
      choice: 'here',
    })
    assert.match(missing.message, /没有提案 nope/)
    // 没声明 sessionTree 的连接不能答
    const other = await plain(env)
    const undeclared = await other.fails('litch/sessionProposal/answer', {
      proposalId: 甲.proposalId,
      choice: 'here',
    })
    assert.match(undeclared.message, /声明了 sessionTree/)
    assert.equal(env.device.sessionTree.store.proposal(甲.proposalId)?.status, 'offered')
    // 还在等用户选的：不能 accept、不能撤回
    const early = await env.pi.callTool(threadId, SESSIONS, 'accept', {
      proposal_id: 甲.proposalId,
      prompt: brief('甲。'),
    })
    assert.equal(failureOf(early?.answer), 'invalid')
    assert.match(early?.answer.result.contentItems[0].text, /has not chosen yet/)
    const withdraw = await env.pi.callTool(threadId, SESSIONS, 'withdraw', {
      proposal_id: 甲.proposalId,
    })
    assert.equal(failureOf(withdraw?.answer), 'invalid')
    // 收尾：回合结束全部了结
    env.pi.end(threadId)
    for (const one of waits) assert.equal(resultOf(await answerOf(one.call)).choice, 'here')
    // 不是用户发起的回合：不收
    env.pi.selfTurn(threadId)
    const self = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '引擎自己的回合',
      initiation: 'offer',
    })
    assert.equal(failureOf(self?.answer), 'blocked')
    assert.match(self?.answer.result.contentItems[0].text, /message the user just typed/)
  } finally {
    await env.close()
  }
})

test('OFFER-006：选了新会话的卡模型可以撤回；设备进程重启时还在等的 offer 卡当作在这里做', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const { proposalId, call } = await offer(env, threadId, '改个名字')
    await client.call('litch/sessionProposal/answer', { proposalId, choice: 'session' })
    await answerOf(call)
    const withdrawn = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'withdraw', { proposal_id: proposalId }))?.answer,
    )
    assert.equal(withdrawn.status, 'withdrawn')
    assert.equal(env.device.sessionTree.store.proposal(proposalId)?.status, 'withdrawn')
  } finally {
    await env.close()
  }
  const dir = tempDir()
  try {
    const db = openSessionDatabase(dir)
    const store = new SessionStore(db)
    const base = {
      threadId: 'p1',
      prompt: '',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh' as const,
      wakeParent: true,
      createdAt: 1,
      expiresAt: 2,
      offer: true,
    }
    store.addProposal({ ...base, id: 'o1', title: '在等选' })
    store.addProposal({ ...base, id: 'o2', title: '选了新会话' })
    store.moveProposal('o2', ['offered'], 'chosen', null)
    store.addProposal({ ...base, id: 'n1', title: '普通的', prompt: 'x', offer: false })
    const lines: string[] = []
    const tree = new SessionTree({ store, log: (line: string) => lines.push(line) } as never)
    tree.close()
    assert.equal(store.proposal('o1')?.status, 'here')
    assert.equal(store.proposal('o2')?.status, 'here')
    assert.ok(typeof store.proposal('o1')?.settledAt === 'number')
    assert.equal(store.proposal('n1')?.status, 'pending', '普通提案不动')
    assert.equal(store.proposal('n1')?.offer, undefined)
    assert.match(lines.join('\n'), /2 张 offer 卡当作在这里做/)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
