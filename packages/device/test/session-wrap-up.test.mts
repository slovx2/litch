// 收尾工具 litch_sessions.wrap_up 和提醒收尾在设备进程里的行为：一次出几张提案、部分不收、和 start 合起来的上限、
// 简报按显示宽度算，用户回合没调收尾时开一个 kind=remind 的回合（一条用户消息之后最多一次、只管用户发起且正常结束的回合、
// 设置能关、和唤醒排队），以及从卡片开始时改“完成后唤醒”。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_TOOL_LIMITS,
  SESSION_TOOLS,
  sessionProposalRules,
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
  refuseSteer,
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
      { title: '补集成测试', ...brief('补订单服务的集成测试。') },
      { title: '太短', prompt: '修一下', background: '发版前' },
      { title: '换 harness', ...brief('整理文档。'), harness: 'claude-code' },
      { title: '没有的 harness', ...brief('做点事。'), harness: 'nope' },
      '不是对象',
      { title: ' 补集成测试 ', ...brief('同一件事又提一遍。') },
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
    // 同一回合收过尾又来一次空的：回错，让它别再调（有的模型被要求不写字时会一遍遍调空收尾）
    const again = await wrapUp(env, threadId, [])
    assert.equal(failureOf(again), 'invalid')
    assert.match(again.result.contentItems[0].text, /already wrapped up/)
    // 别的会话第一次收尾就是空列表：成功
    const quiet = await withTools(client, '顺便问个小问题')
    const empty = resultOf(await wrapUp(env, quiet, []))
    assert.deepEqual(empty.suggestions, [])
    assert.match(empty.note, /Nothing suggested.*Now write your final answer.*complete on its own/)
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
        (await env.pi.callTool(threadId, SESSIONS, 'start', { title, ...brief(title) }))?.answer,
      )
    const result = resultOf(
      await wrapUp(
        env,
        threadId,
        ['丙', '丁', '戊'].map((title) => ({ title, ...brief(title) })),
      ),
    )
    const made = result.suggestions.filter((one: any) => one.proposal_id)
    assert.equal(made.length, SESSION_TOOL_LIMITS.proposalsPerTurn - 2)
    assert.match(result.suggestions[2].refused, /already proposed 4 cards in this turn/)
    // 到上限之后 start 也不收
    const more = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '己',
      ...brief('己'),
    })
    assert.equal(failureOf(more?.answer), 'blocked')
  } finally {
    await env.close()
  }
})

test('WRAP-UP-003：fresh 的背景按显示宽度算，汉字算 2；任务只要非空；fork 不要背景', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const least = SESSION_TOOL_LIMITS.freshBackgroundMinWidth
    const chinese = '字'.repeat(least / 2)
    assert.equal(textWidth(chinese), least)
    const result = resultOf(
      await wrapUp(env, threadId, [
        { title: '中文刚好够', prompt: '短任务', background: chinese },
        { title: '中文差一个', prompt: '短任务', background: '字'.repeat(least / 2 - 1) },
        { title: '英文刚好够', prompt: 'x', background: 'x'.repeat(least) },
        { title: '英文差一个', prompt: 'x', background: `  ${'x'.repeat(least - 1)}  ` },
        // 任务写得再长也顶不了背景
        { title: '没有背景', prompt: '字'.repeat(least) },
        { title: '分叉不要背景', prompt: '换个办法。', kind: 'fork' },
      ]),
    )
    const [ok1, short1, ok2, short2, missing, fork] = result.suggestions
    assert.ok(ok1.proposal_id && ok2.proposal_id && fork.proposal_id)
    assert.match(short1.refused, /width 78; each CJK or other full-width character counts as 2/)
    assert.match(short1.refused, /about 40 Chinese characters/)
    assert.match(short2.refused, /width 79/, '首尾空白不算')
    assert.match(missing.refused, /background is missing/)
    const stored = env.device.sessionTree.store.proposal(ok1.proposal_id)
    assert.equal(stored?.prompt, '短任务')
    assert.equal(stored?.background, chinese)
    assert.equal(env.device.sessionTree.store.proposal(fork.proposal_id)?.background, '')
    // start 同一套
    const refused = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '直接起太短',
      prompt: '任务',
      background: '字'.repeat(least / 2 - 1),
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
        (await env.pi.callTool(threadId, SESSIONS, 'start', { title, ...brief(title) }))?.answer,
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
        { title: '丁', ...brief('丁') },
        { title: '戊', ...brief('戊') },
      ]),
    )
    assert.ok(result.suggestions[0].proposal_id)
    assert.equal(
      env.device.sessionTree.store.proposal(result.suggestions[0].proposal_id)?.turnId,
      remindTurn,
    )
    assert.match(result.suggestions[1].refused, /already proposed 4 cards/)
    // 提醒回合里回答已经在上一个回合了：只要一句，不要再写最终回答
    assert.match(result.note, /End your turn now, with at most one short line/)
    assert.doesNotMatch(result.note, /final answer/)
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

test('WRAP-UP-014：上下文满了、自动压缩失败的回合（引擎报成失败，或者标着完成却带着错误）不提醒，之后正常结束的照常提醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    // Pi 入口把这种回合报成失败，错误里写着原因
    const failed = env.pi.current(threadId) as any
    failed.error = {
      message: '上下文满了，自动压缩失败：…',
      codexErrorInfo: null,
      additionalDetails: null,
    }
    env.pi.end(threadId, 'failed')
    // 别的引擎可能标着完成、却带着错误
    await client.call('turn/start', { threadId, input: text('继续') })
    const odd = env.pi.current(threadId) as any
    odd.error = { message: '输出被截断', codexErrorInfo: null, additionalDetails: null }
    env.pi.end(threadId, 'completed')
    await settle(120)
    assert.equal(injected(env, threadId, 'remind').length, 0, '出错的回合之后开了提醒回合')
    // 问题解决了、下一个回合正常结束：照常提醒
    await client.call('turn/start', { threadId, input: text('再试一次') })
    env.pi.end(threadId, 'completed', '好了')
    await until(() => injected(env, threadId, 'remind').length === 1, '正常结束的回合之后提醒')
  } finally {
    await env.close()
  }
})

test('WRAP-UP-006：设置 sessions.wrapUpReminder 关掉不提醒，wrap_up 照常能用；会话编排关掉也不提醒', async () => {
  const env = treeRig({}, { values: { 'sessions.wrapUpReminder': false } })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const result = resultOf(await wrapUp(env, threadId, [{ title: '甲', ...brief('甲') }]))
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
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const childId = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '子任务',
          ...brief('做点事。'),
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
        { title: '不唤醒', ...brief('不唤醒') },
        { title: '照提案', ...brief('照提案') },
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

test('WRAP-UP-011：模型的 start（直接起、提案）接受 wake_parent，用户从卡片开始时仍可改', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const direct = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '直接起',
          ...brief('直接起。'),
          harness: 'claude-code',
          initiation: 'user_asked',
          wake_parent: false,
        })
      )?.answer,
    )
    assert.equal(env.device.sessionTree.lineage(direct.thread_id)?.wakeParent, false)
    assert.match(direct.note, /do not wake/)
    const proposed = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '提一张',
          ...brief('提一张。'),
          wake_parent: false,
        })
      )?.answer,
    )
    assert.equal(env.device.sessionTree.store.proposal(proposed.proposal_id)?.wakeParent, false)
  } finally {
    await env.close()
  }
})

/** 设备进程转给 pi 的建会话请求里，这个会话的 litch_sessions */
const sentSessions = (env: TreeEnv, index: number) =>
  env.pi.sent('thread/start')[index]?.dynamicTools?.find((spec: any) => spec?.name === SESSIONS)

test('WRAP-UP-012：设置 sessions.wrapUp 关掉：新会话的 litch_sessions 没有 wrap_up、规则不提收尾，不提醒；提案照常；开关只管之后新建的会话', async () => {
  const env = treeRig({}, { values: { 'sessions.wrapUp': false } })
  try {
    const client = await litch(env)
    const offId = await withTools(client)
    const off = sentSessions(env, 0)
    assert.deepEqual(
      off.tools.map((tool: any) => tool.name).includes('wrap_up'),
      false,
      '关着时不给 wrap_up',
    )
    assert.equal(off.instructions, sessionProposalRules(false))
    assert.doesNotMatch(`${off.instructions}\n${off.description}`, /wrap_up/)
    assert.equal(env.device.sessionTree.hasWrapUp(offId), false)
    // 其余照常：提案卡片能出
    resultOf(
      (await env.pi.callTool(offId, SESSIONS, 'start', { title: '甲', ...brief('甲') }))?.answer,
    )
    env.pi.end(offId)
    await settle(80)
    assert.equal(injected(env, offId, 'remind').length, 0, '关着不提醒')
    // 打开：之后新建的会话带 wrap_up、照常提醒；关着时建的那个还是没有，也不提醒
    env.control?.patch({ values: { 'sessions.wrapUp': true } as never })
    await settle(30)
    const onId = await withTools(client)
    const on = sentSessions(env, 1)
    assert.ok(on.tools.some((tool: any) => tool.name === 'wrap_up'))
    assert.equal(on.instructions, SESSION_TOOLS.instructions)
    env.pi.end(onId)
    await until(() => injected(env, onId, 'remind').length === 1, '开着就提醒')
    await until(() => env.pi.running(onId), '提醒回合在跑')
    env.pi.end(onId, 'completed', '好')
    await client.call('turn/start', { threadId: offId, input: text('再来') })
    env.pi.end(offId)
    await settle(80)
    assert.equal(injected(env, offId, 'remind').length, 0, '会话没有 wrap_up 就不提醒')
    // 再关掉：已经带着 wrap_up 的会话也当场不再提醒
    env.control?.patch({ values: { 'sessions.wrapUp': false } as never })
    await settle(30)
    await client.call('turn/start', { threadId: onId, input: text('又来') })
    env.pi.end(onId)
    await settle(80)
    assert.equal(injected(env, onId, 'remind').length, 1)
  } finally {
    await env.close()
  }
})

test('WRAP-UP-013：没有主进程管设置时看启动参数 --wrap-up（DeviceOptions.wrapUp），缺省开；派出的子会话按开关带', async () => {
  assert.equal(parseArgs(BASE_ARGS).wrapUp, undefined, '不写就没有，按开着算')
  assert.equal(parseArgs([...BASE_ARGS, '--wrap-up', 'off']).wrapUp, false)
  assert.equal(parseArgs([...BASE_ARGS, '--wrap-up', 'on']).wrapUp, true)
  assert.throws(() => parseArgs([...BASE_ARGS, '--wrap-up', 'yes']), /on 或 off/)
  const env = treeRig({}, { wrapUp: false })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    assert.equal(env.device.sessionTree.hasWrapUp(threadId), false)
    const childId = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '子任务',
          ...brief('做点事。'),
          initiation: 'user_asked',
        })
      )?.answer,
    ).thread_id as string
    assert.equal(env.device.sessionTree.hasWrapUp(childId), false, '子会话也没有 wrap_up')
    env.pi.end(threadId)
    await settle(80)
    assert.equal(injected(env, threadId, 'remind').length, 0)
  } finally {
    await env.close()
  }
})
