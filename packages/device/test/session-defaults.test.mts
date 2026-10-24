// 起子会话的缺省参数（session-tree.json 的规矩）：harness、model、effort、cwd 不给的取开始那一刻父会话的当前设置，
// 目标 harness 不同时 model、effort 用那边的默认，那个模型没有这一档强度的也用默认；提案记下 effort。
// 五条路径都照这一套：用户点开始（litch/sessionProposal/accept）、litch/session/start、模型的 user_asked 和 accept、
// offer 选了新会话后补简报、hand_off。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { resultOf } from './fake-engine.mjs'
import type { TestClient } from './helpers.mjs'
import {
  brief,
  ECHO_SPEC,
  litch,
  SESSIONS,
  type TreeEnv,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

/** pi 上建一个带 litch_sessions 的父会话、发一个用户回合；父会话现在的模型和强度由假引擎的 thread/resume 报 */
async function parentOn(env: TreeEnv, client: TestClient): Promise<string> {
  env.pi.config = { ...env.pi.config, model: 'gpt-6-astra', reasoningEffort: 'xhigh' } as never
  const started = await client.call('thread/start', {
    harness: 'pi',
    cwd: '/work/app',
    dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
  })
  const threadId = started.thread.id as string
  await client.call('turn/start', { threadId, input: text('帮我做') })
  return threadId
}

/** 子会话建的时候引擎收到的 thread/start（或 thread/fork）和第一个 turn/start */
function childCalls(env: TreeEnv, harness: 'pi' | 'claude', childId: string, fork = false) {
  const engine = harness === 'pi' ? env.pi : env.claude
  const created = engine.sent(fork ? 'thread/fork' : 'thread/start').at(-1)
  const first = engine.sent('turn/start').find((params) => params.threadId === childId)
  return { model: created?.model, effort: first?.effort }
}

const call = async (env: TreeEnv, threadId: string, tool: string, args: object) =>
  resultOf((await env.pi.callTool(threadId, SESSIONS, tool, args))?.answer)

test('DEFAULTS-001：用户点开始：没写 model、effort 的提案用父会话那一刻的；提案里写了 effort 的记进库、照它', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    const wrapped = await call(env, threadId, 'wrap_up', {
      suggestions: [
        { title: '缺省的', ...brief('缺省的') },
        { title: '写了强度的', ...brief('写了强度的'), effort: 'low' },
      ],
    })
    const [plainId, lowId] = wrapped.suggestions.map((one: any) => one.proposal_id)
    assert.equal(env.device.sessionTree.store.proposal(plainId)?.effort, null)
    assert.equal(env.device.sessionTree.store.proposal(lowId)?.effort, 'low')
    const listed = await client.call('litch/sessionProposal/list', { threadId })
    assert.equal(
      listed.proposals.find((one: any) => one.id === lowId).effort,
      'low',
      '列出来带 effort',
    )
    // 用户在卡片外改了父会话的设置：开始时取那一刻的
    env.pi.config = { ...env.pi.config, model: 'gpt-6-luna' } as never
    const { threadId: plainChild } = await client.call('litch/sessionProposal/accept', {
      proposalId: plainId,
    })
    assert.deepEqual(childCalls(env, 'pi', plainChild), { model: 'gpt-6-luna', effort: 'xhigh' })
    const { threadId: lowChild } = await client.call('litch/sessionProposal/accept', {
      proposalId: lowId,
    })
    assert.deepEqual(childCalls(env, 'pi', lowChild), { model: 'gpt-6-luna', effort: 'low' })
  } finally {
    await env.close()
  }
})

test('DEFAULTS-002：目标 harness 不同、没写 model、effort：不带，用那边的默认；写了的照带', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    // 模型给的型号要在目标 harness 的清单里（session-options.mts 的校验）
    env.claude.handlers['model/list'] = () => ({ data: [{ id: 'opus' }], nextCursor: null })
    const other = await call(env, threadId, 'start', {
      title: '换 harness',
      ...brief('换 harness'),
      harness: 'claude-code',
      initiation: 'user_asked',
    })
    assert.deepEqual(childCalls(env, 'claude', other.thread_id), {
      model: undefined,
      effort: undefined,
    })
    const given = await call(env, threadId, 'start', {
      title: '换 harness 带模型',
      ...brief('换 harness 带模型'),
      harness: 'claude-code',
      model: 'opus',
      effort: 'high',
      initiation: 'user_asked',
    })
    assert.deepEqual(childCalls(env, 'claude', given.thread_id), { model: 'opus', effort: 'high' })
  } finally {
    await env.close()
  }
})

test('DEFAULTS-003：那个模型没有这一档强度（model/list 说的）：不带，用默认；问不到 model/list 的照带', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    env.claude.handlers['model/list'] = () => ({
      data: [
        {
          id: 'opus',
          model: 'opus',
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
        },
      ],
      nextCursor: null,
    })
    const start = (title: string, effort: string) =>
      call(env, threadId, 'start', {
        title,
        ...brief(title),
        harness: 'claude-code',
        effort,
        initiation: 'user_asked',
      })
    const missing = await start('没有这一档', 'xhigh')
    assert.equal(childCalls(env, 'claude', missing.thread_id).effort, undefined)
    const fits = await start('有这一档', 'high')
    assert.equal(childCalls(env, 'claude', fits.thread_id).effort, 'high')
    delete env.claude.handlers['model/list']
    const unknown = await start('问不到', 'xhigh')
    assert.equal(childCalls(env, 'claude', unknown.thread_id).effort, 'xhigh')
  } finally {
    await env.close()
  }
})

test('DEFAULTS-004：litch/session/start、模型的 user_asked、hand_off（分叉）都取父会话的模型和强度', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    const { threadId: byUser } = await client.call('litch/session/start', {
      parentThreadId: threadId,
      kind: 'fresh',
      title: '手动派的',
      prompt: '手动派的',
      wakeParent: true,
    })
    assert.deepEqual(childCalls(env, 'pi', byUser), { model: 'gpt-6-astra', effort: 'xhigh' })
    const asked = await call(env, threadId, 'start', {
      title: '用户要的',
      ...brief('用户要的'),
      initiation: 'user_asked',
    })
    assert.deepEqual(childCalls(env, 'pi', asked.thread_id), {
      model: 'gpt-6-astra',
      effort: 'xhigh',
    })
    const handed = await call(env, threadId, 'hand_off', {
      title: '交出去',
      remaining_plan: '剩下的步骤',
    })
    assert.deepEqual(childCalls(env, 'pi', handed.thread_id, true), {
      model: 'gpt-6-astra',
      effort: 'xhigh',
    })
  } finally {
    await env.close()
  }
})

test('DEFAULTS-005：offer 选了新会话、模型补简报：effort 照 accept 给的，没给的取父会话的；模型的 accept 开普通提案照提案', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    const pending = env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '新任务',
      initiation: 'offer',
    })
    let offerId = ''
    await until(() => {
      offerId = env.device.sessionTree.proposals(threadId).find((one) => one.offer)?.id ?? ''
      return offerId !== ''
    }, 'offer 卡落下')
    await client.call('litch/sessionProposal/answer', { proposalId: offerId, choice: 'session' })
    await pending
    const accepted = await call(env, threadId, 'accept', {
      proposal_id: offerId,
      ...brief('新任务'),
      effort: 'medium',
    })
    assert.deepEqual(childCalls(env, 'pi', accepted.thread_id), {
      model: 'gpt-6-astra',
      effort: 'medium',
    })
    // 普通提案：模型的 accept 只给 proposal_id，effort 是只给 offer 补简报用的
    const proposalId = (
      await call(env, threadId, 'start', { title: '提案', ...brief('提案'), effort: 'low' })
    ).proposal_id
    const started = await call(env, threadId, 'accept', { proposal_id: proposalId })
    assert.deepEqual(childCalls(env, 'pi', started.thread_id), {
      model: 'gpt-6-astra',
      effort: 'low',
    })
  } finally {
    await env.close()
  }
})
