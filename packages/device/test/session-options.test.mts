// litch_sessions.options 和模型给的 harness、model 的校验（session-options.mts）：options 照各 harness 的 model/list 列
// 能选的型号（隐藏的不列）、强度、缺省型号和调用者现在用的；start、wrap_up 的建议、offer 补简报时给了不认识的
// harness 或型号回 invalid、带可选项，不开会话、不落提案；认得的换成清单里的写法。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
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

/** Claude Code 的型号清单：两个供应商，一个藏起来的（没填密钥的那家），opus 两家都有 */
const CLAUDE_MODELS = {
  data: [
    {
      id: 'anthropic/opus',
      model: 'anthropic/opus',
      displayName: '[Account] Opus 5.5',
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
    },
    {
      id: 'anthropic/sonnet',
      model: 'anthropic/sonnet',
      displayName: '[Account] Sonnet 5.5',
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
    },
    {
      id: 'deepseek/deepseek-v4',
      model: 'deepseek/deepseek-v4',
      displayName: '[DeepSeek] deepseek-v4',
      hidden: false,
      supportedReasoningEfforts: [],
    },
    {
      id: 'work/opus',
      model: 'work/opus',
      displayName: '[Work] Opus 5.5',
      hidden: false,
      supportedReasoningEfforts: [],
    },
    { id: 'nokey/big', model: 'nokey/big', displayName: '[No key] big', hidden: true },
  ],
  nextCursor: null,
}

/** pi 上建一个带 litch_sessions 的父会话、发一个用户回合；pi 现在用 gpt-6-astra（不在 pi 的清单里，老会话那样） */
async function parentOn(env: TreeEnv, client: TestClient): Promise<string> {
  env.pi.config = { ...env.pi.config, model: 'gpt-6-astra', reasoningEffort: 'xhigh' } as never
  env.pi.handlers['model/list'] = () => ({
    data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: true }],
    nextCursor: null,
  })
  env.claude.handlers['model/list'] = () => CLAUDE_MODELS
  const started = await client.call('thread/start', {
    harness: 'pi',
    cwd: '/work/app',
    dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
  })
  const threadId = started.thread.id as string
  await client.call('turn/start', { threadId, input: text('帮我做') })
  return threadId
}

const answer = async (env: TreeEnv, threadId: string, tool: string, args: object) =>
  (await env.pi.callTool(threadId, SESSIONS, tool, args))?.answer

const call = async (env: TreeEnv, threadId: string, tool: string, args: object) =>
  resultOf(await answer(env, threadId, tool, args))

const failureText = (reply: any): string => reply?.result?.contentItems?.[0]?.text ?? ''

/** claude-code 上最近一次 thread/start 的 model */
const lastClaudeModel = (env: TreeEnv) => env.claude.sent('thread/start').at(-1)?.model

test('OPTIONS-001：options 列每个 harness 能选的型号（隐藏的不列）、强度、缺省型号，和这个会话现在用的', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    const result = await call(env, threadId, 'options', {})
    assert.deepEqual(result.current, { harness: 'pi', model: 'gpt-6-astra', effort: 'xhigh' })
    const claude = result.harnesses.find((one: any) => one.harness === 'claude-code')
    assert.equal(claude.default_model, 'anthropic/opus')
    assert.deepEqual(
      claude.models.map((one: any) => one.id),
      ['anthropic/opus', 'anthropic/sonnet', 'deepseek/deepseek-v4', 'work/opus'],
      '没填密钥的那家（hidden）不列',
    )
    assert.deepEqual(claude.models[0], {
      id: 'anthropic/opus',
      name: '[Account] Opus 5.5',
      efforts: ['low', 'high'],
      default_effort: 'high',
    })
    const pi = result.harnesses.find((one: any) => one.harness === 'pi')
    assert.deepEqual(pi.models, [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: [] }])
    // 只查一个；列不出清单的报原因
    delete env.claude.handlers['model/list']
    const only = await call(env, threadId, 'options', { harness: 'claude-code' })
    assert.equal(only.harnesses.length, 1)
    assert.equal(only.harnesses[0].harness, 'claude-code')
    assert.ok(only.harnesses[0].unavailable, '列不出来的带原因')
    assert.deepEqual(only.harnesses[0].models, [])
    const unknown = await answer(env, threadId, 'options', { harness: 'gemini' })
    assert.equal(failureOf(unknown), 'invalid')
    assert.match(failureText(unknown), /Harnesses here: pi, claude-code/)
  } finally {
    await env.close()
  }
})

test('OPTIONS-002：start 给了不认识的 harness、型号回 invalid 带可选项，不开会话；认得的换成清单里的写法', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    const start = (title: string, more: object) =>
      answer(env, threadId, 'start', { title, ...brief(title), initiation: 'user_asked', ...more })
    const starts = () => env.claude.sent('thread/start').length
    const before = starts()
    const noHarness = await start('没有这个 harness', { harness: 'gemini' })
    assert.equal(failureOf(noHarness), 'invalid')
    assert.match(failureText(noHarness), /Harnesses here: pi, claude-code.*litch_sessions\.options/)
    const noModel = await start('没有这个型号', { harness: 'claude-code', model: 'gpt-9' })
    assert.equal(failureOf(noModel), 'invalid')
    assert.match(failureText(noModel), /no model "gpt-9" on claude-code/)
    assert.match(failureText(noModel), /anthropic\/opus \(\[Account\] Opus 5\.5\)/)
    assert.doesNotMatch(failureText(noModel), /nokey/, '藏起来的不提示')
    const hidden = await start('藏起来的', { harness: 'claude-code', model: 'nokey/big' })
    assert.equal(failureOf(hidden), 'invalid', '没填密钥的供应商的型号不认')
    const twice = await start('两家都有', { harness: 'claude-code', model: 'opus' })
    assert.equal(failureOf(twice), 'invalid')
    assert.match(failureText(twice), /matches several models.*anthropic\/opus.*work\/opus/)
    assert.equal(starts(), before, '不认的一个会话都没开')
    // 认得的：大小写不同换成清单里的，不带供应商的裸型号恰好一家有就换成那一家的
    resultOf(await start('大小写', { harness: 'claude-code', model: 'Anthropic/Sonnet' }))
    assert.equal(lastClaudeModel(env), 'anthropic/sonnet')
    resultOf(await start('裸型号', { harness: 'claude-code', model: 'deepseek-v4' }))
    assert.equal(lastClaudeModel(env), 'deepseek/deepseek-v4')
    // 同 harness、和父会话现在用的一样：清单里没有也认（老会话的型号）
    resultOf(await start('父会话的', { model: 'gpt-6-astra' }))
    assert.equal(env.pi.sent('thread/start').at(-1)?.model, 'gpt-6-astra')
    // 列不出清单：不拦，照原样交给引擎
    delete env.claude.handlers['model/list']
    resultOf(await start('列不出', { harness: 'claude-code', model: 'whatever' }))
    assert.equal(lastClaudeModel(env), 'whatever')
  } finally {
    await env.close()
  }
})

test('OPTIONS-003：propose、wrap_up 的建议、offer 补简报照同一套：不认的不落卡或回 invalid，认得的记清单里的写法', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await parentOn(env, client)
    const proposed = await answer(env, threadId, 'start', {
      title: '提案',
      ...brief('提案'),
      harness: 'claude-code',
      model: 'gpt-9',
    })
    assert.equal(failureOf(proposed), 'invalid')
    const wrapped = await call(env, threadId, 'wrap_up', {
      suggestions: [
        { title: '不认的', ...brief('不认的'), harness: 'claude-code', model: 'gpt-9' },
        { title: '认得的', ...brief('认得的'), harness: 'claude-code', model: 'ANTHROPIC/OPUS' },
      ],
    })
    assert.match(wrapped.suggestions[0].refused, /no model "gpt-9"/)
    const made = env.device.sessionTree.store.proposal(wrapped.suggestions[1].proposal_id)
    assert.equal(made?.model, 'anthropic/opus')
    assert.equal(env.device.sessionTree.proposals(threadId).length, 1, '不认的没落卡')
    // offer：卡上的型号先查；选了新会话、补简报时给的也查
    const badOffer = await answer(env, threadId, 'start', {
      title: '新任务',
      initiation: 'offer',
      harness: 'claude-code',
      model: 'gpt-9',
    })
    assert.equal(failureOf(badOffer), 'invalid')
    const pending = env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '新任务',
      initiation: 'offer',
      harness: 'claude-code',
    })
    let offerId = ''
    await until(() => {
      offerId = env.device.sessionTree.proposals(threadId).find((one) => one.offer)?.id ?? ''
      return offerId !== ''
    }, 'offer 卡落下')
    await client.call('litch/sessionProposal/answer', { proposalId: offerId, choice: 'session' })
    await pending
    const bad = await answer(env, threadId, 'accept', {
      proposal_id: offerId,
      ...brief('新任务'),
      model: 'gpt-9',
    })
    assert.equal(failureOf(bad), 'invalid')
    const good = await call(env, threadId, 'accept', {
      proposal_id: offerId,
      ...brief('新任务'),
      model: 'sonnet',
    })
    assert.ok(good.thread_id)
    assert.equal(lastClaudeModel(env), 'anthropic/sonnet')
  } finally {
    await env.close()
  }
})
