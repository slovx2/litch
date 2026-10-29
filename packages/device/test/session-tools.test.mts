// litch_sessions 由设备进程执行（device-tools.mts 注册的命名空间，session-tools.mts）：读类看所有会话，写类对自己的子孙、
// 用户发起的回合里不限、发消息还可以发给用户 @ 过的；
// 设置里关掉会话编排；原生 codex 发给每条连接的几份并成一次；父子关系重启之后还在。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { sessionMentionsBlock } from '../../protocol/src/session-mentions.mjs'
import { parseSessionMessage } from '../../protocol/src/system-messages.mjs'
import { DeviceServer } from '../src/device.mjs'
import { tightened } from '../src/session-start.mjs'
import { codexRig } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { assertRuntimeInfo, settle, TestClient } from './helpers.mjs'
import { brief, litch, parent, refuseSteer, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

async function family(env: ReturnType<typeof treeRig>) {
  const client = await litch(env)
  const { threadId } = await parent(client)
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
  return { client, threadId, childId }
}

test('SESSION-TOOLS-001：list、read 看这台设备上所有会话（mine 只看自己的子孙），读到的回合掐过、注入的那段去掉', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    const stranger = await client.call('thread/start', { harness: 'claude-code', cwd: '/other' })
    const all = resultOf((await env.pi.callTool(threadId, SESSIONS, 'list', {}))?.answer)
    const ids = all.sessions.map((one: any) => one.thread_id)
    assert.ok(ids.includes(threadId) && ids.includes(childId) && ids.includes(stranger.thread.id))
    const child = all.sessions.find((one: any) => one.thread_id === childId)
    assert.deepEqual(
      [child.harness, child.cwd, child.status, child.parent_thread_id, child.mine],
      ['claude-code', '/work/app', 'running', threadId, true],
    )
    assert.equal(all.sessions.find((one: any) => one.thread_id === stranger.thread.id).mine, false)
    const mine = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'list', { scope: 'mine' }))?.answer,
    )
    assert.deepEqual(
      mine.sessions.map((one: any) => one.thread_id),
      [childId],
    )
    const filtered = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'list', { harness: 'claude-code', cwd: '/other' }))
        ?.answer,
    )
    assert.deepEqual(
      filtered.sessions.map((one: any) => one.thread_id),
      [stranger.thread.id],
    )
    env.claude.end(childId, 'completed', `开头${'x'.repeat(5000)}结尾`)
    const read = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'read', { thread_id: childId }))?.answer,
    )
    assert.equal(read.session.status, 'idle')
    assert.equal(read.turns.length, 1)
    assert.equal(read.turns[0].status, 'completed')
    assert.ok(read.turns[0].answer.startsWith('开头') && read.turns[0].answer.endsWith('结尾'))
    assert.equal(read.turns[0].answer.length, 4000, '掐头留尾')
    assert.match(read.turns[0].input, /Task: 子任务/)
    const bad = await env.pi.callTool(threadId, SESSIONS, 'read', { thread_id: 'nope' })
    assert.equal(failureOf(bad?.answer), 'invalid')
    const wrong = await env.pi.callTool(threadId, SESSIONS, 'list', { limit: 500 })
    assert.equal(failureOf(wrong?.answer), 'invalid')
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-002：不是用户发起的回合里，send、interrupt 只能对自己的子孙；别的会话、引擎自己的子代理线程、自己都回 blocked', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    const stranger = (await client.call('thread/start', { harness: 'claude-code' })).thread.id
    // 引擎自己开的回合（不是用户发起的）
    env.pi.end(threadId)
    env.pi.selfTurn(threadId)
    env.claude.threads.push({ id: 'native-sub', updatedAt: 1, parentThreadId: stranger })
    for (const target of [stranger, 'native-sub', threadId]) {
      const sent = await env.pi.callTool(threadId, SESSIONS, 'send', {
        thread_id: target,
        message: 'hi',
      })
      assert.equal(failureOf(sent?.answer), 'blocked', target)
      const stopped = await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: target })
      assert.equal(failureOf(stopped?.answer), 'blocked', target)
    }
    const native = await env.pi.callTool(threadId, SESSIONS, 'send', {
      thread_id: 'native-sub',
      message: 'x',
    })
    assert.match(native?.answer.result.contentItems[0].text, /subagent tools/)
    const other = await env.pi.callTool(threadId, SESSIONS, 'send', {
      thread_id: stranger,
      message: 'x',
    })
    assert.match(other?.answer.result.contentItems[0].text, /Ask the user/)
    // 自己的子会话在跑：插进它正在跑的回合；停下了：开新回合。都标明来自哪个会话
    const steer = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'send', {
          thread_id: childId,
          message: '先跑单测',
        })
      )?.answer,
    )
    assert.match(steer.note, /running now/)
    assert.match(
      env.claude.sent('turn/steer')[0].input[0].text,
      new RegExp(`\\(${threadId}\\), not typed by the user`),
    )
    // 客户端认得回来（画成“来自 X 的消息”）：发来的会话、原话
    const parsed = parseSessionMessage(env.claude.sent('turn/steer')[0].input[0].text)
    assert.equal(parsed?.from.id, threadId)
    assert.equal(parsed?.message, '先跑单测')
    const stop = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: childId }))?.answer,
    )
    assert.match(stop.note, /Interrupted/)
    assert.equal(env.claude.sent('turn/interrupt')[0].threadId, childId)
    await until(() => !env.device.sessionTree.isActive(childId), '打断之后不在跑了')
    resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'send', { thread_id: childId, message: '再来' }))
        ?.answer,
    )
    assert.equal(
      parseSessionMessage(env.claude.sent('turn/start').at(-1).input[0].text)?.message,
      '再来',
    )
    // 孙子也算自己的子孙
    const grandchild = resultOf(
      (
        await env.claude.callTool(childId, SESSIONS, 'start', {
          title: '孙子',
          ...brief('更细的活。'),
          initiation: 'propose',
        })
      )?.answer,
    )
    const { threadId: grandId } = await client.call('litch/sessionProposal/accept', {
      proposalId: grandchild.proposal_id,
    })
    assert.equal(env.device.sessionTree.store.descends(grandId, threadId), true)
    const deep = await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: grandId })
    assert.match(resultOf(deep?.answer).note, /Interrupted/)
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-009：用户发起的回合里 send、interrupt 不限；两个会话之间发过一次消息（send、打断、用户 @）就一直能互相发，打断不算', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const stranger = (await client.call('thread/start', { harness: 'claude-code' })).thread.id
    const other = (await client.call('thread/start', { harness: 'claude-code' })).thread.id
    const third = (await client.call('thread/start', { harness: 'claude-code' })).thread.id
    const stopped = (await client.call('thread/start', { harness: 'claude-code' })).thread.id
    // 用户回合：别人的会话也发得出、打断得了；对面收到怎么回
    const sent = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'send', {
          thread_id: stranger,
          message: '看一下',
        })
      )?.answer,
    )
    assert.match(sent.note, /new turn/)
    assert.match(
      env.claude.sent('turn/start').at(-1).input[0].text,
      new RegExp(`litch_sessions\\.send to thread_id ${threadId}`),
    )
    // 教模型怎么回的那句不算对方的原话
    assert.equal(
      parseSessionMessage(env.claude.sent('turn/start').at(-1).input[0].text)?.message,
      '看一下',
    )
    resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: stranger }))?.answer,
    )
    await client.call('turn/start', { threadId: stopped, input: text('跑着') })
    resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: stopped }))?.answer,
    )
    // 用户在回合里插话时 @ 了 other
    const mention = `看看 ＠[另一个]\n\n${sessionMentionsBlock([{ threadId: other, title: '另一个' }])}`
    const running = env.device.sessionTree.activeTurn(threadId)
    await client.call('turn/steer', { threadId, input: text(mention), expectedTurnId: running })
    env.pi.end(threadId)
    env.pi.selfTurn(threadId)
    // 不是用户回合了：从没互相发过的不行
    const refused = await env.pi.callTool(threadId, SESSIONS, 'send', {
      thread_id: third,
      message: 'x',
    })
    assert.equal(failureOf(refused?.answer), 'blocked')
    assert.match(refused?.answer.result.contentItems[0].text, /never messaged each other.*mention/)
    // 发过的（用户回合里 send 过、打断过、@ 过）：两边随时能互相发
    for (const target of [stranger, stopped, other]) {
      resultOf(
        (
          await env.pi.callTool(threadId, SESSIONS, 'send', {
            thread_id: target,
            message: '你那边呢',
          })
        )?.answer,
      )
      env.claude.end(target)
      resultOf(
        (
          await env.claude.callTool(target, SESSIONS, 'send', {
            thread_id: threadId,
            message: '好了',
          })
        )?.answer,
      )
    }
    // 打断不因为发过消息就放开
    const stop = await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: other })
    assert.equal(failureOf(stop?.answer), 'blocked')
    const store = env.device.sessionTree.store
    assert.equal(store.contacted(other, threadId), true)
    assert.equal(store.contacted(threadId, third), false)
    // 归档、恢复都不影响；删掉的才忘掉
    await client.call('thread/archive', { threadId: stranger })
    await client.call('thread/unarchive', { threadId: stranger })
    assert.equal(store.contacted(threadId, stranger), true)
    env.device.sessionTree.deleted(stranger)
    assert.equal(store.contacted(threadId, stranger), false)
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-010：子会话能给父会话发消息（派出就算发过）；别的会话经 harness 自己的收件箱发来的消息也算发过', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    env.claude.end(childId)
    env.claude.selfTurn(childId)
    resultOf(
      (
        await env.claude.callTool(childId, SESSIONS, 'send', {
          thread_id: threadId,
          message: '父会话你好',
        })
      )?.answer,
    )
    // 另一个会话用 Claude 的 SendMessage 给 pi 上的父会话发过（用户消息条目上的 litchPeer 是发送方）
    const peer = (await client.call('thread/start', { harness: 'claude-code' })).thread.id
    await client.call('turn/start', { threadId: peer, input: text('开始') })
    env.pi.end(threadId)
    env.pi.selfTurn(threadId)
    env.claude.end(peer)
    env.claude.selfTurn(peer)
    const blocked = await env.claude.callTool(peer, SESSIONS, 'send', {
      thread_id: threadId,
      message: 'x',
    })
    assert.equal(failureOf(blocked?.answer), 'blocked')
    env.pi.notify('item/completed', {
      threadId,
      turnId: env.pi.current(threadId)?.id,
      item: {
        type: 'userMessage',
        id: 'peer-1',
        content: [],
        litchPeer: { name: '对面', thread: peer },
      },
    })
    await until(
      () => env.device.sessionTree.store.contacted(peer, threadId),
      '收件箱来的消息记下了',
    )
    resultOf(
      (await env.claude.callTool(peer, SESSIONS, 'send', { thread_id: threadId, message: '回你' }))
        ?.answer,
    )
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-003：wait 等到子会话停下或者到点，带回最后的回答；参数不对的回 invalid', async () => {
  const env = treeRig()
  try {
    const { threadId, childId } = await family(env)
    const waiting = env.pi.callTool(threadId, SESSIONS, 'wait', {
      thread_ids: [childId],
      timeout_seconds: 5,
    })
    await settle(50)
    env.claude.end(childId, 'completed', '做完了')
    const done = resultOf((await waiting)?.answer)
    assert.equal(done.timed_out, false)
    assert.equal(done.sessions[0].status, 'idle')
    assert.equal(done.sessions[0].last_answer, '做完了')
    env.claude.selfTurn(childId)
    const late = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'wait', {
          thread_ids: [childId],
          timeout_seconds: 1,
        })
      )?.answer,
    )
    assert.equal(late.timed_out, true)
    assert.equal(late.sessions[0].status, 'running')
    assert.equal(late.sessions[0].last_answer, null)
    for (const args of [
      { thread_ids: [] },
      { thread_ids: Array(9).fill(childId) },
      { thread_ids: [childId], timeout_seconds: 999 },
    ]) {
      const bad = await env.pi.callTool(threadId, SESSIONS, 'wait', args)
      assert.equal(failureOf(bad?.answer), 'invalid')
    }
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-004：设置里关掉会话编排：设备信息不列 sessionTree，方法回不支持，工具回 disabled，不回报；打开后照常，攒着的唤醒补上', async () => {
  const env = treeRig({}, { values: { 'sessions.enabled': true } })
  try {
    const { client, threadId, childId } = await family(env)
    const on = await client.call('runtime/info', {})
    assertRuntimeInfo(on)
    assert.ok(on.device.extensions.includes('sessionTree'))
    env.control?.patch({ values: { 'sessions.enabled': false } as never })
    const off = await client.call('runtime/info', {})
    assertRuntimeInfo(off)
    assert.ok(!off.device.extensions.includes('sessionTree'))
    const refused = await client.fails('litch/session/start', {
      parentThreadId: threadId,
      kind: 'fresh',
      title: 'x',
      prompt: 'y',
      wakeParent: true,
    })
    assert.equal(refused.code, -32601)
    const disabled = await env.pi.callTool(threadId, SESSIONS, 'list', {})
    assert.equal(failureOf(disabled?.answer), 'disabled')
    env.claude.end(childId, 'completed', '关着的时候做完的')
    env.pi.end(threadId)
    await settle(60)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0, '关着不回报')
    // 已有的父子关系照常显示
    const read = await client.call('thread/read', { threadId: childId })
    assert.equal(read.thread.litchLineage.parentThreadId, threadId)
    env.control?.patch({ values: { 'sessions.enabled': true } as never })
    env.claude.selfTurn(childId)
    env.claude.end(childId, 'completed', '打开之后')
    await until(
      () => env.pi.sent('turn/start').some((params) => params.input[0].text.includes('打开之后')),
      '打开之后照常唤醒',
    )
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-005：设备进程替每条通往适配器的连接声明 litch_sessions；客户端没声明 clientTools 时它列的命名空间仍然不算数', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const mobile = env.connect()
    await mobile.initialize(['harness'], { litchClientTools: { namespaces: ['litch_browser'] } })
    await settle(20)
    const greetings = [...env.pi.greetings.values()]
    // 两条客户端连接各一条上游连接
    assert.equal(greetings.length, 2)
    for (const greeting of greetings) {
      assert.ok(greeting.capabilities.litchExtensions.includes('clientTools'))
      assert.ok(greeting.capabilities.litchClientTools.namespaces.includes(SESSIONS))
    }
    const namespaces = greetings.map(
      (greeting) => greeting.capabilities.litchClientTools.namespaces,
    )
    // 定时任务的 litch_tasks 先注册，排在前面
    assert.deepEqual(namespaces, [
      ['litch_echo', 'litch_tasks', 'litch_manager', SESSIONS],
      ['litch_tasks', 'litch_manager', SESSIONS],
    ])
    // 设备进程自己的连接（第一次用到时才开）也声明
    const { threadId } = await parent(client)
    await env.pi.callTool(threadId, SESSIONS, 'list', {})
    const own = [...env.pi.greetings.values()].find(
      (greeting) => greeting.clientInfo.name === 'litch-device',
    )
    assert.deepEqual(own.capabilities.litchClientTools.namespaces, [
      'litch_tasks',
      'litch_manager',
      SESSIONS,
    ])
    assert.deepEqual(SESSION_TOOLS.name, SESSIONS)
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-006：原生 codex 把同一个 litch_sessions 调用发给每条连接：设备进程只执行一次、只答一次', async () => {
  const env = codexRig()
  try {
    const desktop = env.connect()
    await desktop.initialize()
    const litchClient = env.connect()
    await litchClient.initialize(['harness', 'sessionTree'])
    const thread = codexThread(1, 400).id
    await desktop.call('thread/resume', { threadId: thread })
    await litchClient.call('thread/resume', { threadId: thread })
    await litchClient.call('turn/start', { threadId: thread, input: text('列一下') })
    const { id } = env.codex.toolCall(thread, SESSIONS)
    await until(
      () => env.codex.connections.flatMap((connection) => connection.answers).length > 0,
      '应当有答复',
    )
    await settle(50)
    const answers = env.codex.connections.flatMap((connection) => connection.answers)
    assert.equal(answers.length, 1, '几份并成一次')
    assert.equal(answers[0].id, id)
    // 工具名是 echo，不是 litch_sessions 的：参数不对，但照样是设备进程答的，没有转给任何客户端
    assert.match(answers[0].result.contentItems[0].text, /^\[litch:invalid\]/)
    for (const client of [desktop, litchClient])
      assert.equal(client.requests.filter((frame) => frame.method === 'item/tool/call').length, 0)
    // codex 的握手里没有我们的扩展键
    for (const greeting of env.codex.greetings)
      assert.equal(greeting.capabilities.litchClientTools, undefined)
  } finally {
    await env.close()
  }
})

test('SESSION-TOOLS-007：父子关系、提案、回报存在 sessions.sqlite 里，设备进程重启之后还在', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  const { threadId, childId } = await family(env)
  env.claude.end(childId, 'completed', '重启前做完的')
  await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
  await env.device.close()
  const again = new DeviceServer({
    stateDir: env.stateDir,
    importExisting: false,
    version: '9.9.9',
    upstreams: [
      { id: 'pi', connect: env.pi.connector },
      { id: 'claude-code', connect: env.claude.connector },
    ],
    timing: { retryMs: [20], settleMs: 500, probeTimeoutMs: 500, listTimeoutMs: 500 },
  })
  try {
    const client = new TestClient(again)
    await client.initialize(['harness', 'sessionTree'])
    const read = await client.call('thread/read', { threadId: childId })
    assert.equal(read.thread.litchLineage.parentThreadId, threadId)
    assert.equal(again.sessionTree.store.notes(threadId).length, 1)
  } finally {
    await again.close()
    await env.close().catch(() => {})
  }
})

test('SESSION-TOOLS-008：子会话的审批策略、沙箱取父会话和请求值里更严的那个', () => {
  const parentOf = (approvalPolicy: unknown, sandbox: unknown) => ({ approvalPolicy, sandbox })
  assert.deepEqual(tightened(parentOf('on-request', { type: 'workspaceWrite' }), {}), {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  })
  assert.deepEqual(
    tightened(parentOf('on-request', { type: 'workspaceWrite' }), {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }),
    { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  )
  assert.deepEqual(
    tightened(parentOf('never', { type: 'dangerFullAccess' }), {
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    }),
    { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  )
  assert.deepEqual(tightened(null, { approvalPolicy: 'never' }), { approvalPolicy: 'never' })
  assert.deepEqual(tightened(null, {}), {})
})
