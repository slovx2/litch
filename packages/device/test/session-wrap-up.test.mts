// 收尾工具 litch_sessions.wrap_up 和提醒收尾在设备进程里的行为：一次出几张提案、部分不收、和 start 合起来的上限、
// 简报按显示宽度算，用户回合没调收尾时开一个 kind=remind 的回合（一条用户消息之后最多一次、只管用户发起且正常结束的回合、
// 设置能关、和唤醒排队），以及从卡片开始时改“完成后唤醒”。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_TOOL_LIMITS,
  SESSION_TOOLS,
  textWidth,
} from '../../protocol/src/client-tools-sessions.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { parseArgs } from '../src/args.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import type { TestClient } from './helpers.mjs'
import {
  brief,
  ECHO_SPEC,
  litch,
  parent,
  SESSIONS,
  type TreeEnv,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

const BASE_ARGS = ['--listen', 'unix:///tmp/d.sock', '--state', '/tmp/state']

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 设备进程替 pi 上的会话开的回合里，某种注入事件（remind、wake）的那些，按顺序 */
const injected = (env: TreeEnv, threadId: string, kind: 'remind' | 'wake') =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .map((params) => parseSessionEvent(String(params.input?.[0]?.text ?? '')).event)
    .filter((event) => event?.kind === kind)

/** 在 pi 上建一个带 litch_sessions 的会话（像 Litch 客户端建的），再发一个用户回合 */
async function withTools(client: TestClient, say = '帮我看看还剩什么'): Promise<string> {
  const started = await client.call('thread/start', {
    harness: 'pi',
    cwd: '/work/app',
    dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
  })
  const threadId = started.thread.id as string
  await client.call('turn/start', { threadId, input: text(say) })
  return threadId
}

/** 模型调一次 wrap_up，回答复 */
const wrapUp = async (env: TreeEnv, threadId: string, suggestions: unknown) =>
  (await env.pi.callTool(threadId, SESSIONS, 'wrap_up', { suggestions }))?.answer

test('WRAP-UP-001：一次 wrap_up 出几张提案，callId 是这次调用、turnId 照记；不收的写 refused，其余照收；空列表也成功', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const turnId = env.pi.current(threadId)?.id
    const answer = await wrapUp(env, threadId, [
      { title: '补集成测试', prompt: brief('补订单服务的集成测试。') },
      { title: '太短', prompt: '修一下' },
      { title: '换 harness', prompt: brief('整理文档。'), harness: 'claude-code' },
      { title: '没有的 harness', prompt: brief('做点事。'), harness: 'nope' },
      '不是对象',
      { title: ' 补集成测试 ', prompt: brief('同一件事又提一遍。') },
      { title: '分叉', prompt: '接着做', kind: 'fork' },
    ])
    const result = resultOf(answer)
    assert.equal(result.suggestions.length, 7, '和给的一一对应')
    const [first, short, other, missing, odd, twin, fork] = result.suggestions
    assert.ok(first.proposal_id && !first.refused)
    assert.match(short.refused, /too short.*counts as 2/)
    assert.equal(short.proposal_id, undefined)
    assert.ok(other.proposal_id)
    assert.match(missing.refused, /no harness "nope"/)
    assert.equal(odd.title, '')
    assert.match(odd.refused, /must be an object/)
    assert.match(twin.refused, /still waiting for the user/)
    assert.ok(fork.proposal_id, 'fork 不查简报宽度')
    assert.match(result.note, /3 suggested-task cards/)
    assert.match(result.note, /4 suggestions were refused/)
    // 提案记着这次 wrap_up 的调用和回合
    const stored = env.device.sessionTree.store.proposal(first.proposal_id)
    assert.equal(stored?.turnId, turnId)
    assert.match(String(stored?.callId), /^call-req-\d+$/)
    assert.equal(env.device.sessionTree.store.proposal(other.proposal_id)?.callId, stored?.callId)
    assert.equal(env.device.sessionTree.store.proposal(other.proposal_id)?.harness, 'claude-code')
    assert.equal(stored?.wakeParent, true)
    // 空列表
    const empty = resultOf(await wrapUp(env, threadId, []))
    assert.deepEqual(empty.suggestions, [])
    assert.match(empty.note, /Nothing suggested.*without writing any more text/)
    // suggestions 不是数组：整个调用不收
    const bad = await env.pi.callTool(threadId, SESSIONS, 'wrap_up', {})
    assert.equal(failureOf(bad?.answer), 'invalid')
    assert.match(bad?.answer.result.contentItems[0].text, /suggestions must be an array/)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-002：一回合的上限 start 和 wrap_up 合起来算', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    for (const title of ['甲', '乙'])
      resultOf(
        (await env.pi.callTool(threadId, SESSIONS, 'start', { title, prompt: brief(title) }))
          ?.answer,
      )
    const result = resultOf(
      await wrapUp(
        env,
        threadId,
        ['丙', '丁', '戊'].map((title) => ({ title, prompt: brief(title) })),
      ),
    )
    const made = result.suggestions.filter((one: any) => one.proposal_id)
    assert.equal(made.length, SESSION_TOOL_LIMITS.proposalsPerTurn - 2)
    assert.match(result.suggestions[2].refused, /already proposed 4 cards in this turn/)
    // 到上限之后 start 也不收
    const more = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '己',
      prompt: brief('己'),
    })
    assert.equal(failureOf(more?.answer), 'blocked')
  } finally {
    await env.close()
  }
})

test('WRAP-UP-003：fresh 简报按显示宽度算，汉字算 2', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const least = SESSION_TOOL_LIMITS.freshPromptMinWidth
    const chinese = '字'.repeat(least / 2)
    assert.equal(textWidth(chinese), least)
    const result = resultOf(
      await wrapUp(env, threadId, [
        { title: '中文刚好够', prompt: chinese },
        { title: '中文差一个', prompt: '字'.repeat(least / 2 - 1) },
        { title: '英文刚好够', prompt: 'x'.repeat(least) },
        { title: '英文差一个', prompt: `  ${'x'.repeat(least - 1)}  ` },
      ]),
    )
    const [ok1, short1, ok2, short2] = result.suggestions
    assert.ok(ok1.proposal_id && ok2.proposal_id)
    assert.match(short1.refused, /width 78; each CJK or other full-width character counts as 2/)
    assert.match(short1.refused, /about 40 Chinese characters/)
    assert.match(short2.refused, /width 79/, '首尾空白不算')
    // start 同一套
    const refused = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '直接起太短',
      prompt: '字'.repeat(least / 2 - 1),
      initiation: 'user_asked',
    })
    assert.equal(failureOf(refused?.answer), 'invalid')
    assert.match(refused?.answer.result.contentItems[0].text, /counts as 2/)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-004：用户回合正常结束、没调 wrap_up：开一个 kind=remind 的回合，一条用户消息之后只一次；提醒回合里的 wrap_up 照常建提案，上限连同那个用户回合算', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const userTurn = env.pi.current(threadId)?.id as string
    for (const title of ['甲', '乙', '丙'])
      resultOf(
        (await env.pi.callTool(threadId, SESSIONS, 'start', { title, prompt: brief(title) }))
          ?.answer,
      )
    env.pi.end(threadId, 'completed', '做完了，还剩两件事')
    await until(() => injected(env, threadId, 'remind').length === 1, '开了提醒回合')
    const [remind] = injected(env, threadId, 'remind')
    assert.deepEqual(remind?.notes, [])
    await until(() => env.pi.running(threadId), '提醒回合在跑')
    const remindTurn = env.pi.current(threadId)?.id as string
    assert.notEqual(remindTurn, userTurn)
    assert.equal(env.device.sessionTree.isUserTurn('pi', remindTurn), false)
    // 提醒回合里调 wrap_up：照常建提案；上限把那个用户回合里 start 提的三张也算上
    const result = resultOf(
      await wrapUp(env, threadId, [
        { title: '丁', prompt: brief('丁') },
        { title: '戊', prompt: brief('戊') },
      ]),
    )
    assert.ok(result.suggestions[0].proposal_id)
    assert.equal(
      env.device.sessionTree.store.proposal(result.suggestions[0].proposal_id)?.turnId,
      remindTurn,
    )
    assert.match(result.suggestions[1].refused, /already proposed 4 cards/)
    // 提醒回合本身不调收尾也不会再提醒
    env.pi.end(threadId, 'completed', '好')
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 1, '一条用户消息之后最多一次')
    // 下一条用户消息：调了收尾就不提醒
    await client.call('turn/start', { threadId, input: text('再来') })
    resultOf(await wrapUp(env, threadId, []))
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 1, '调过收尾的回合不提醒')
    // 再下一条：没调，又提醒一次
    await client.call('turn/start', { threadId, input: text('还有') })
    env.pi.end(threadId)
    await until(() => injected(env, threadId, 'remind').length === 2, '新的用户消息之后又提醒')
  } finally {
    await env.close()
  }
})

test('WRAP-UP-005：被打断、失败的回合，不是用户发起的回合，没带 litch_sessions 的会话都不提醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    env.pi.end(threadId, 'interrupted')
    await client.call('turn/start', { threadId, input: text('再试') })
    env.pi.end(threadId, 'failed')
    // 引擎自己续跑的回合（唤醒、定时任务的回合也一样不是客户端用 turn/start 发起的）
    env.pi.selfTurn(threadId)
    env.pi.end(threadId)
    // 没带 litch_sessions 的会话（旧的、别的客户端建的）
    const { threadId: plainId } = await parent(client)
    env.pi.end(plainId)
    await settle(120)
    assert.equal(injected(env, threadId, 'remind').length, 0)
    assert.equal(injected(env, plainId, 'remind').length, 0)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-006：设置 sessions.wrapUpReminder 关掉不提醒，wrap_up 照常能用；会话编排关掉也不提醒', async () => {
  const env = treeRig({}, { values: { 'sessions.wrapUpReminder': false } })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const result = resultOf(await wrapUp(env, threadId, [{ title: '甲', prompt: brief('甲') }]))
    assert.ok(result.suggestions[0].proposal_id)
    env.pi.end(threadId)
    await client.call('turn/start', { threadId, input: text('不调收尾') })
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 0)
    // 打开提醒、关掉会话编排：也不提醒
    env.control?.patch({
      values: { 'sessions.wrapUpReminder': true, 'sessions.enabled': false } as never,
    })
    await settle(30)
    await client.call('turn/start', { threadId, input: text('再来') })
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 0)
    // 都开着：提醒
    env.control?.patch({ values: { 'sessions.enabled': true } as never })
    await settle(30)
    await client.call('turn/start', { threadId, input: text('又来') })
    env.pi.end(threadId)
    await until(() => injected(env, threadId, 'remind').length === 1, '开着就提醒')
  } finally {
    await env.close()
  }
})

test('WRAP-UP-007：同一时刻该提醒也该唤醒：先提醒，提醒回合结束后再唤醒；唤醒回合不引出提醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const childId = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '子任务',
          prompt: brief('做点事。'),
          harness: 'claude-code',
          initiation: 'user_asked',
        })
      )?.answer,
    ).thread_id as string
    env.claude.end(childId, 'completed', '子会话做完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => injected(env, threadId, 'remind').length === 1, '先提醒')
    assert.equal(injected(env, threadId, 'wake').length, 0, '提醒回合在跑，不唤醒')
    await until(() => env.pi.running(threadId), '提醒回合在跑')
    env.pi.end(threadId)
    await until(() => injected(env, threadId, 'wake').length === 1, '提醒回合结束后唤醒')
    const order = env.pi
      .sent('turn/start')
      .filter((params) => params.threadId === threadId)
      .map((params) => parseSessionEvent(String(params.input[0].text)).event?.kind ?? 'user')
    assert.deepEqual(order, ['user', 'remind', 'wake'])
    // 唤醒回合不调收尾也不提醒
    await until(() => env.pi.running(threadId), '唤醒回合在跑')
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 1)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-008：litch/sessionProposal/accept 的 overrides.wakeParent 改起出来的子会话唤不唤醒父会话', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const [one, two] = resultOf(
      await wrapUp(env, threadId, [
        { title: '不唤醒', prompt: brief('不唤醒') },
        { title: '照提案', prompt: brief('照提案') },
      ]),
    ).suggestions
    const bad = await client.fails('litch/sessionProposal/accept', {
      proposalId: one.proposal_id,
      overrides: { wakeParent: 'no' },
    })
    assert.equal(bad.code, -32602)
    assert.match(bad.message, /wakeParent/)
    const quiet = await client.call('litch/sessionProposal/accept', {
      proposalId: one.proposal_id,
      overrides: { wakeParent: false },
    })
    assert.equal(env.device.sessionTree.lineage(quiet.threadId)?.wakeParent, false)
    const loud = await client.call('litch/sessionProposal/accept', {
      proposalId: two.proposal_id,
    })
    assert.equal(env.device.sessionTree.lineage(loud.threadId)?.wakeParent, true)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-009：提醒等着发（会话还没闲下来）时，用户又说话、或者别的回合里调了 wrap_up，这次提醒作废', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    // 引擎读出来的会话一直说在跑（状态晚到）：提醒排着发不出去
    const read = env.pi.handlers['thread/read'] as NonNullable<(typeof env.pi.handlers)[string]>
    const busy = (params: any, connection: any) => {
      const answer = read(params, connection) as any
      return { thread: { ...answer.thread, status: { type: 'active', activeFlags: [] } } }
    }
    env.pi.handlers['thread/read'] = busy
    env.pi.end(threadId)
    await settle(60)
    assert.equal(injected(env, threadId, 'remind').length, 0, '会话不闲，先不发')
    // 用户又说话：作废；这一回合被打断，结束时也不提醒
    await client.call('turn/start', { threadId, input: text('接着') })
    env.pi.handlers['thread/read'] = read
    env.pi.end(threadId, 'interrupted')
    await settle(60)
    assert.equal(injected(env, threadId, 'remind').length, 0, '用户又说话之后旧的提醒作废')
    // 再一次：排着的提醒被引擎自己续跑的回合里的 wrap_up 收掉
    env.pi.handlers['thread/read'] = busy
    await client.call('turn/start', { threadId, input: text('再来') })
    env.pi.end(threadId)
    await settle(60)
    env.pi.handlers['thread/read'] = read
    env.pi.selfTurn(threadId)
    resultOf(await wrapUp(env, threadId, []))
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 0, '别的回合里收了尾，提醒作废')
    // 对照：排着的提醒在会话闲下来、有回合结束时照发
    env.pi.handlers['thread/read'] = busy
    await client.call('turn/start', { threadId, input: text('最后') })
    env.pi.end(threadId)
    await settle(60)
    env.pi.handlers['thread/read'] = read
    env.pi.selfTurn(threadId)
    env.pi.end(threadId)
    await until(() => injected(env, threadId, 'remind').length === 1, '闲下来之后照发')
  } finally {
    await env.close()
  }
})

test('WRAP-UP-010：没有主进程管设置时看启动参数 --wrap-up-reminder（DeviceOptions.wrapUpReminder），缺省提醒', async () => {
  assert.equal(parseArgs(BASE_ARGS).wrapUpReminder, undefined, '不写就没有，按开着算')
  assert.equal(parseArgs([...BASE_ARGS, '--wrap-up-reminder', 'off']).wrapUpReminder, false)
  assert.equal(parseArgs([...BASE_ARGS, '--wrap-up-reminder', 'on']).wrapUpReminder, true)
  assert.throws(() => parseArgs([...BASE_ARGS, '--wrap-up-reminder', 'no']), /on 或 off/)
  const env = treeRig({}, { wrapUpReminder: false })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 0)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-011：唤不唤醒由 Litch 定：模型的 start（直接起、提案）给了 wake_parent 也不认，一律唤醒；用户从卡片开始时仍可改', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const direct = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '直接起',
          prompt: brief('直接起。'),
          harness: 'claude-code',
          initiation: 'user_asked',
          wake_parent: false,
        })
      )?.answer,
    )
    assert.equal(env.device.sessionTree.lineage(direct.thread_id)?.wakeParent, true)
    assert.match(direct.note, /you will be woken/)
    const proposed = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '提一张',
          prompt: brief('提一张。'),
          wake_parent: 'no',
        })
      )?.answer,
    )
    assert.equal(env.device.sessionTree.store.proposal(proposed.proposal_id)?.wakeParent, true)
  } finally {
    await env.close()
  }
})
