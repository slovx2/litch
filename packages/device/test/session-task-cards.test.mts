// 任务卡第二轮在设备进程里的行为：任务卡按 harness 的开关（harness.<id>.taskCards：新会话挑没有建议的那组工具、
// 已有会话当场生效、派子会话按子会话的 harness 挑），普通提案卡上的“在这里做”（litch/sessionProposal/here），
// wrap_up 的 ask、actions 的整理。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_TOOL_LIMITS,
  SESSION_TOOLS,
  sessionProposalRules,
  wrapUpAsk,
} from '../../protocol/src/client-tools-sessions.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import type { TestClient } from './helpers.mjs'
import {
  brief,
  ECHO_SPEC,
  got,
  litch,
  SESSIONS,
  type TreeEnv,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

const CARDS_OFF = /Task cards are turned off for pi/
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 在某个 harness 上建一个带 litch_sessions 的会话（像 Litch 客户端建的），再发一个用户回合 */
async function withTools(client: TestClient, harness = 'pi', say = '帮我看看'): Promise<string> {
  const started = await client.call('thread/start', {
    harness,
    cwd: '/work/app',
    dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
  })
  const threadId = started.thread.id as string
  await client.call('turn/start', { threadId, input: text(say) })
  return threadId
}

/** 一份动态工具里的 litch_sessions */
const sessionsIn = (tools: unknown): any =>
  (Array.isArray(tools) ? tools : []).find((spec: any) => spec?.name === SESSIONS)

const toolNames = (spec: any): string[] => spec.tools.map((tool: any) => tool.name)

const initiations = (spec: any): string[] =>
  spec.tools.find((tool: any) => tool.name === 'start').inputSchema.properties.initiation.enum

/** 设备进程替 pi 上的会话开的回合里，提醒收尾的那些 */
const reminders = (env: TreeEnv, threadId: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .filter(
      (params) => parseSessionEvent(String(params.input?.[0]?.text ?? '')).event?.kind === 'remind',
    )

test('TASK-CARDS-001：harness.pi.taskCards 关着：pi 上新建的会话拿没有建议的那份（没有 wrap_up、start 只收 user_asked、规则不提建议），别的 harness 照旧', async () => {
  const env = treeRig({}, { values: { 'harness.pi.taskCards': false } })
  try {
    const client = await litch(env)
    const piId = await withTools(client, 'pi')
    const off = sessionsIn(env.pi.sent('thread/start').at(-1)?.dynamicTools)
    assert.equal(toolNames(off).includes('wrap_up'), false)
    assert.deepEqual(initiations(off), ['user_asked'])
    assert.equal(off.instructions, sessionProposalRules(true, false))
    assert.doesNotMatch(off.instructions, /wrap_up|offer|propose|suggest/i)
    assert.equal(env.device.sessionTree.hasWrapUp(piId), false)
    await withTools(client, 'claude-code')
    const on = sessionsIn(env.claude.sent('thread/start').at(-1)?.dynamicTools)
    assert.ok(toolNames(on).includes('wrap_up'))
    assert.deepEqual(initiations(on), ['user_asked', 'propose', 'offer'])
    assert.equal(on.instructions, SESSION_TOOLS.instructions)
    // 关着的会话这一回合没收尾也不提醒
    env.pi.end(piId)
    await settle(80)
    assert.equal(reminders(env, piId).length, 0)
  } finally {
    await env.close()
  }
})

test('TASK-CARDS-002：已有会话当场生效：wrap_up 照收但建议都 refused、ask 照常；propose 回 blocked；offer 当在这里做；user_asked 照起；不再提醒', async () => {
  const env = treeRig({}, { values: { 'harness.pi.taskCards': true } })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    assert.equal(env.device.sessionTree.hasWrapUp(threadId), true, '建的时候开着，带着 wrap_up')
    env.control?.patch({ values: { 'harness.pi.taskCards': false } as never })
    await settle(30)
    const wrapped = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'wrap_up', {
          suggestions: [{ title: '补测试', ...brief('补测试') }],
          ask: '要在这里接着修吗？',
          actions: [{ label: '在这里修' }],
        })
      )?.answer,
    )
    assert.equal(wrapped.suggestions.length, 1)
    assert.match(wrapped.suggestions[0].refused, CARDS_OFF)
    assert.equal(wrapped.suggestions[0].proposal_id, undefined)
    assert.match(wrapped.note, /question with its buttons/)
    assert.match(wrapped.note, CARDS_OFF)
    assert.equal(env.device.sessionTree.proposals(threadId).length, 0, '一张卡都没落')
    const proposed = (
      await env.pi.callTool(threadId, SESSIONS, 'start', { title: '整理文档', ...brief('整理') })
    )?.answer
    assert.equal(failureOf(proposed), 'blocked')
    assert.match(proposed.result.contentItems[0].text, CARDS_OFF)
    const offered = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '另一件事',
          initiation: 'offer',
        })
      )?.answer,
    )
    assert.equal(offered.choice, 'here')
    assert.equal(offered.proposal_id, undefined)
    assert.match(offered.note, /do "另一件事" here/)
    assert.equal(env.device.sessionTree.proposals(threadId, true).length, 0)
    const started = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '用户要的',
          ...brief('用户要的'),
          initiation: 'user_asked',
        })
      )?.answer,
    )
    assert.ok(started.thread_id, '用户明说的照样直接起')
    // 下一个用户回合没调收尾：开关关着，不提醒
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '回合结束')
    await client.call('turn/start', { threadId, input: text('再看看') })
    env.pi.end(threadId)
    await settle(80)
    assert.equal(reminders(env, threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('TASK-CARDS-003：任务卡关闭，非用户回合也可直接启动已授权子会话，不落卡', async () => {
  const env = treeRig({}, { values: { 'harness.pi.taskCards': false } })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '用户回合结束')
    // 不是用户发起的回合（引擎自己续跑）
    env.pi.selfTurn(threadId)
    const answer = (
      await env.pi.callTool(threadId, SESSIONS, 'start', {
        title: '子任务',
        ...brief('子任务'),
        initiation: 'user_asked',
      })
    )?.answer
    assert.ok(resultOf(answer).thread_id)
    assert.equal(env.device.sessionTree.proposals(threadId, true).length, 0)
  } finally {
    await env.close()
  }
})

test('TASK-CARDS-004：派子会话按子会话的 harness 挑那份：claude-code 上的父会话派到 pi（关着）没有建议，派到自己（开着）照旧', async () => {
  const env = treeRig({}, { values: { 'harness.pi.taskCards': false } })
  try {
    const client = await litch(env)
    const parentId = await withTools(client, 'claude-code')
    const startOn = async (harness: string) =>
      resultOf(
        (
          await env.claude.callTool(parentId, SESSIONS, 'start', {
            title: `派到 ${harness}`,
            ...brief(`派到 ${harness}`),
            harness,
            initiation: 'user_asked',
          })
        )?.answer,
      ).thread_id as string
    const onPi = await startOn('pi')
    const piTools = sessionsIn(env.device.sessionTree.store.tools(onPi))
    assert.equal(toolNames(piTools).includes('wrap_up'), false)
    assert.deepEqual(initiations(piTools), ['user_asked'])
    assert.ok(sessionsIn(env.pi.sent('thread/start').at(-1)?.dynamicTools), '建子会话时就是这一份')
    const onClaude = await startOn('claude-code')
    const claudeTools = sessionsIn(env.device.sessionTree.store.tools(onClaude))
    assert.ok(toolNames(claudeTools).includes('wrap_up'))
  } finally {
    await env.close()
  }
})

/** 在 pi 的父会话上提一张普通提案，返回提案号 */
async function propose(env: TreeEnv, threadId: string, title: string): Promise<string> {
  const answer = (
    await env.pi.callTool(threadId, SESSIONS, 'start', { title, ...brief(`${title}的任务原文`) })
  )?.answer
  return resultOf(answer).proposal_id as string
}

/** 设备进程替这个会话发的 turn/start 里，第一段文字是 text 的 */
const sentText = (env: TreeEnv, threadId: string, wanted: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .filter((params) => String(params.input?.at(-1)?.text ?? '').includes(wanted))

test('HERE-001：普通提案卡上点“在这里做”：提案记 here；父会话在跑时排到回合后，发 lead 加标题、空一行加任务（不带背景），算用户回合', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const proposalId = await propose(env, threadId, '补集成测试')
    assert.deepEqual(
      await client.call('litch/sessionProposal/here', { proposalId, lead: '在这里做：' }),
      {},
    )
    const stored = env.device.sessionTree.store.proposal(proposalId)
    assert.equal(stored?.status, 'here')
    assert.ok(stored?.settledAt)
    await until(
      () =>
        got(client, 'litch/sessionProposal/changed').some(
          (one) => one.changed[0]?.id === proposalId && one.changed[0]?.status === 'here',
        ),
      '收到提案变成 here 的通知',
    )
    await settle(40)
    const message = '在这里做：补集成测试\n\n补集成测试的任务原文'
    assert.equal(sentText(env, threadId, message).length, 0, '父会话在跑，先不发')
    env.pi.end(threadId)
    await until(() => sentText(env, threadId, message).length === 1, '回合结束后发出')
    const sent = sentText(env, threadId, message)[0]
    assert.equal(sent.input.at(-1).text, message)
    assert.doesNotMatch(sent.input.at(-1).text, /Background|整理/, '不带背景')
    const turnId = env.pi.current(threadId)?.id as string
    assert.ok(turnId)
    assert.equal(env.device.sessionTree.isUserTurn('pi', turnId), true, '算用户发起的回合')
    // 已经了结了的再点：不支持
    const again = await client.fails('litch/sessionProposal/here', { proposalId })
    assert.match(again.message, /已经当作在这里做了结了/)
  } finally {
    await env.close()
  }
})

test('HERE-002：父会话闲着当场发，lead 不给用英文；offer 卡、不存在的提案不收', async () => {
  // 提醒收尾关掉：这里只看“在这里做”的回合
  const env = treeRig({}, { wrapUpReminder: false })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const proposalId = await propose(env, threadId, 'Tidy docs')
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '回合结束')
    await client.call('litch/sessionProposal/here', { proposalId })
    const message = 'Do it here: Tidy docs\n\nTidy docs的任务原文'
    await until(() => sentText(env, threadId, message).length === 1, '当场发出')
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '回合结束')
    // offer 卡（offered）不是 pending，不收
    await client.call('turn/start', { threadId, input: text('另一件事') })
    const call = env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '另一件',
      initiation: 'offer',
    })
    let offerId = ''
    await until(() => {
      offerId = env.device.sessionTree.proposals(threadId).find((one) => one.offer)?.id ?? ''
      return offerId !== ''
    }, 'offer 卡落下')
    const refused = await client.fails('litch/sessionProposal/here', { proposalId: offerId })
    assert.match(refused.message, /还在等用户选/)
    await client.call('litch/sessionProposal/answer', { proposalId: offerId, choice: 'here' })
    await call
    const missing = await client.fails('litch/sessionProposal/here', { proposalId: 'nope' })
    assert.match(missing.message, /没有提案 nope/)
  } finally {
    await env.close()
  }
})

test('HERE-003：markHere 只了结提案、把那句话交回给客户端，设备进程自己不发（回合结束后也不发）；重复问回同一句', async () => {
  const env = treeRig({}, { wrapUpReminder: false })
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const proposalId = await propose(env, threadId, '补集成测试')
    const message = '在这里做：补集成测试\n\n补集成测试的任务原文'
    assert.deepEqual(
      await client.call('litch/sessionProposal/markHere', { proposalId, lead: '在这里做：' }),
      { text: message },
    )
    assert.equal(env.device.sessionTree.store.proposal(proposalId)?.status, 'here')
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '回合结束')
    await settle(60)
    assert.equal(sentText(env, threadId, message).length, 0, '设备进程不发')
    // 应答丢了客户端再问一遍：回同一句话；改用 here 让设备进程发的照样不行
    assert.deepEqual(await client.call('litch/sessionProposal/markHere', { proposalId }), {
      text: message,
    })
    const again = await client.fails('litch/sessionProposal/here', { proposalId })
    assert.match(again.message, /已经当作在这里做了结了/)
  } finally {
    await env.close()
  }
})

test('ASK-001：wrapUpAsk 按规矩整理：超长截断、按钮多的丢掉、空的 label 丢掉、没 ask 时连按钮不要，都不算错', () => {
  assert.deepEqual(wrapUpAsk({ suggestions: [] }), { value: null, trimmed: false })
  assert.deepEqual(wrapUpAsk({ actions: [{ label: '好' }] }), { value: null, trimmed: true })
  assert.deepEqual(wrapUpAsk({ ask: '  ', actions: [{ label: '好' }] }), {
    value: null,
    trimmed: true,
  })
  assert.deepEqual(wrapUpAsk({ ask: '修吗？', actions: [{ label: '修', message: '在这里修' }] }), {
    value: { ask: '修吗？', actions: [{ label: '修', message: '在这里修' }] },
    trimmed: false,
  })
  const long = wrapUpAsk({
    ask: '问'.repeat(SESSION_TOOL_LIMITS.askChars + 5),
    actions: [
      { label: '' },
      { label: '甲'.repeat(SESSION_TOOL_LIMITS.actionLabelChars + 1), message: '  ' },
      'not an object',
      { label: '乙', message: '话'.repeat(SESSION_TOOL_LIMITS.actionMessageChars + 1) },
      { label: '丙' },
    ],
  })
  assert.equal(long.trimmed, true)
  assert.equal(long.value?.ask.length, SESSION_TOOL_LIMITS.askChars)
  assert.deepEqual(
    long.value?.actions.map((one) => [one.label.length, one.message?.length]),
    [
      [SESSION_TOOL_LIMITS.actionLabelChars, undefined],
      [1, SESSION_TOOL_LIMITS.actionMessageChars],
    ],
    '空的、不是对象的丢掉，最多两个，空 message 去掉',
  )
  // 截断按码点算，不切开代理对
  const emoji = wrapUpAsk({ ask: '😀'.repeat(SESSION_TOOL_LIMITS.askChars + 1) })
  assert.equal(Array.from(emoji.value?.ask ?? '').length, SESSION_TOOL_LIMITS.askChars)
})

test('ASK-002：wrap_up 带 ask、actions：不建提案、照常收尾，超长的在话里提一句；有按钮没问题的照常成功', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const threadId = await withTools(client)
    const result = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'wrap_up', {
          suggestions: [],
          ask: '要在这里接着修吗？',
          actions: [{ label: '在这里修' }, { label: '先不' }, { label: '多余的' }],
        })
      )?.answer,
    )
    assert.deepEqual(result.suggestions, [])
    assert.match(result.note, /question with its buttons at the end of the turn \(shortened/)
    assert.match(result.note, /Your turn is wrapped up/)
    assert.equal(env.device.sessionTree.proposals(threadId, true).length, 0, '问题不落提案')
    assert.equal(
      env.device.sessionTree.isWrappedUp(threadId, env.pi.current(threadId)?.id ?? ''),
      true,
    )
    const other = await withTools(client)
    const lone = resultOf(
      (
        await env.pi.callTool(other, SESSIONS, 'wrap_up', {
          suggestions: [],
          actions: [{ label: '好' }],
        })
      )?.answer,
    )
    assert.match(lone.note, /ask was empty/)
  } finally {
    await env.close()
  }
})
