import assert from 'node:assert/strict'
import test from 'node:test'
import type { PermissionDecision } from '../src/types.mjs'
import { parseAskUserQuestions } from '../src/user-questions.mjs'
import { declaring } from './fixtures/extension-wire.mjs'
import { type Connection, openStage, type Stage, type TurnScript } from './fixtures/in-process.mjs'

// 一个会话多个订阅连接（设计文档 03 第八节 A6）之二：等人回答的请求。
// 审批、提问、MCP 征询用同一个请求号发给全部订阅连接；先答的生效，拿着这条请求的其余连接收到
// serverRequest/resolved，它们迟到的应答被丢弃、不产生任何效果。
// 扩展内容（审批里的“拒绝并附说明”）按每条连接自己握手时的声明给。

const text = (value: string) => [{ type: 'text', text: value }]
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const COMMAND = 'item/commandExecution/requestApproval'

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name)
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

// 一个要确认的命令：模型得到的决定记在 decisions 里，有几个就是运行时被答复了几次。
function commandNeedingApproval(decisions: PermissionDecision[]): TurnScript {
  return async (_context, handlers) => {
    const call = { toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'echo hi' } }
    await handlers.onEvent({ type: 'tool_use', ...call })
    const decision = await handlers.onPermissionRequest({
      type: 'permission_request',
      requestId: 'perm-1',
      ...call,
    })
    decisions.push(decision)
    const allowed = decision.decision === 'accept'
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: call.toolUseId,
      content: allowed ? 'hi\n' : 'denied by user',
      isError: !allowed,
    })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
}

// plain 没声明任何扩展（官方桌面端），aware 声明了“拒绝并附说明”。plain 新建会话，aware 恢复它。
async function mixed(stage: Stage): Promise<{
  plain: Connection
  aware: Connection
  threadId: string
}> {
  const plain = await stage.connect('plain')
  const aware = await stage.connect('aware', declaring('declineWithNote'))
  const { thread } = await plain.request('thread/start', { cwd: stage.directory })
  await aware.request('thread/resume', { threadId: thread.id })
  await settle()
  return { plain, aware, threadId: thread.id }
}

const resolvedFor = (connection: Connection, request: { id: unknown }) =>
  connection
    .notifications('serverRequest/resolved')
    .filter((message) => message.params.requestId === request.id)

test('MULTI-REQ-001：审批发给全部订阅连接，各按自己的声明给参数；带说明的拒绝照常生效，迟到的应答被丢弃', async () => {
  await withStage('multi-approval', async (stage) => {
    const { plain, aware, threadId } = await mixed(stage)
    const decisions: PermissionDecision[] = []
    stage.script = commandNeedingApproval(decisions)
    const { turn } = await plain.request('turn/start', { threadId, input: text('跑一条命令') })
    const standard = await plain.serverRequest(COMMAND)
    const extended = await aware.serverRequest(COMMAND)
    assert.equal(extended.id, standard.id, '同一条请求，请求号相同')
    assert.deepEqual(standard.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    assert.deepEqual(
      extended.params,
      {
        ...standard.params,
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel'],
      },
      '声明过的连接多出一个决定，别的字段相同',
    )

    // 没发起回合的那条连接带着说明拒绝。
    await aware.answer(extended, { decision: { declineWithNote: { note: '换一条命令' } } })
    assert.equal((await plain.completed(turn.id)).status, 'completed')
    assert.deepEqual(decisions, [{ decision: 'decline', note: '换一条命令' }])
    for (const connection of [plain, aware])
      assert.equal(resolvedFor(connection, standard).length, 1, `${connection.name} 被告知一次`)
    assert.ok(
      plain.trace.indexOf(resolvedFor(plain, standard)[0]) <
        plain.trace.findIndex((message) => message.method === 'turn/completed'),
      '已解决的通知先于回合结束',
    )

    // 另一条连接这时才同意：请求早就没了，什么都不发生。
    const before = [plain.trace.length, aware.trace.length]
    await plain.answer(standard, { decision: 'accept' })
    await settle()
    assert.deepEqual([plain.trace.length, aware.trace.length], before)
    assert.equal(decisions.length, 1, '运行时只被答复一次')
  })
})

test('MULTI-REQ-002：提问两边都收到，一边答了，另一边收到已解决，它之后的应答不起作用', async () => {
  await withStage('multi-question', async (stage) => {
    const { plain, aware, threadId } = await mixed(stage)
    const answers: unknown[] = []
    stage.script = async (_context, handlers) => {
      const reply = await handlers.onUserInputRequest?.({
        type: 'user_input_request',
        requestId: 'ask-1',
        toolUseId: 'tool-ask',
        questions: parseAskUserQuestions({
          questions: [
            {
              header: 'Auth',
              question: '用哪种登录方式？',
              multiSelect: false,
              options: [
                { label: 'OAuth', description: '' },
                { label: 'API Key', description: '' },
              ],
            },
          ],
        }),
      })
      answers.push(reply?.answers.q0?.answers)
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    }
    const { turn } = await aware.request('turn/start', { threadId, input: text('问我一个问题') })
    const asked = await plain.serverRequest('item/tool/requestUserInput')
    assert.deepEqual(await aware.serverRequest('item/tool/requestUserInput'), asked)

    await plain.answer(asked, { answers: { q0: { answers: ['OAuth'] } } })
    assert.equal((await aware.completed(turn.id)).status, 'completed')
    await aware.answer(asked, { answers: { q0: { answers: ['API Key'] } } })
    await settle()
    assert.deepEqual(answers, [['OAuth']])
    for (const connection of [plain, aware])
      assert.equal(resolvedFor(connection, asked).length, 1, `${connection.name} 被告知一次`)
  })
})

test('MULTI-REQ-003：回合里的 MCP 征询同样发给全部订阅连接，先答的生效', async () => {
  await withStage('multi-elicitation', async (stage) => {
    const { plain, aware, threadId } = await mixed(stage)
    const results: unknown[] = []
    stage.script = async (_context, handlers) => {
      results.push(
        await handlers.onElicitationRequest?.(
          {
            serverName: 'fixture',
            message: '要一个名字',
            mode: 'form',
            requestedSchema: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          } as any,
          new AbortController().signal,
        ),
      )
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    }
    const { turn } = await plain.request('turn/start', { threadId, input: text('调一个 MCP 工具') })
    const elicited = await aware.serverRequest('mcpServer/elicitation/request')
    assert.deepEqual(await plain.serverRequest('mcpServer/elicitation/request'), elicited)
    await aware.answer(elicited, { action: 'accept', content: { name: '甲' } })
    assert.equal((await plain.completed(turn.id)).status, 'completed')
    await plain.answer(elicited, { action: 'decline' })
    await settle()
    assert.deepEqual(results, [{ action: 'accept', content: { name: '甲' } }])
    for (const connection of [plain, aware])
      assert.equal(resolvedFor(connection, elicited).length, 1)
  })
})

test('MULTI-REQ-004：后来才订阅的连接补收到还在等的审批，先拿着的连接不被撤回，谁先答都算', async () => {
  await withStage('multi-replay', async (stage) => {
    const plain = await stage.connect('plain')
    const { thread } = await plain.request('thread/start', { cwd: stage.directory })
    const decisions: PermissionDecision[] = []
    stage.script = commandNeedingApproval(decisions)
    const { turn } = await plain.request('turn/start', {
      threadId: thread.id,
      input: text('跑一条命令'),
    })
    const original = await plain.serverRequest(COMMAND)

    const late = await stage.connect('late', declaring('declineWithNote'))
    await late.request('thread/resume', { threadId: thread.id })
    const replayed = await late.serverRequest(COMMAND)
    assert.equal(replayed.id, original.id, '补送的请求号不变')
    assert.ok(
      replayed.params.availableDecisions.includes('declineWithNote'),
      '按它自己的声明给参数',
    )
    assert.ok(
      late.trace.findIndex((message) => message.id === replayed.id) >
        late.trace.findLastIndex((message) => !message.method && message.result?.thread),
      '补送的请求排在恢复会话的应答之后',
    )
    await settle()
    assert.equal(plain.requests(COMMAND).length, 1, '已经拿着的连接不重复收')
    assert.equal(resolvedFor(plain, original).length, 0, '也不被告知撤回')

    await plain.answer(original, { decision: 'accept' })
    assert.equal((await late.completed(turn.id)).status, 'completed')
    assert.deepEqual(decisions, [{ decision: 'accept' }])
    assert.equal(resolvedFor(late, original).length, 1)
    assert.equal(resolvedFor(plain, original).length, 1)
  })
})

test('MULTI-REQ-005：拿着审批的连接断开或退订一条，请求留给另一条；退订的那条被告知撤回，它再答不算', async () => {
  for (const how of ['disconnect', 'unsubscribe'] as const)
    await withStage(`multi-leave-${how}`, async (stage) => {
      const { plain, aware, threadId } = await mixed(stage)
      const decisions: PermissionDecision[] = []
      stage.script = commandNeedingApproval(decisions)
      const { turn } = await plain.request('turn/start', { threadId, input: text('跑一条命令') })
      const request = await plain.serverRequest(COMMAND)
      await aware.serverRequest(COMMAND)

      if (how === 'disconnect') plain.disconnect()
      else {
        await plain.request('thread/unsubscribe', { threadId })
        assert.equal(resolvedFor(plain, request).length, 1, '退订的连接被告知撤掉卡片')
        await plain.answer(request, { decision: 'accept' })
      }
      await settle()
      assert.deepEqual(decisions, [], '请求还在等留下的那条连接')
      assert.equal(resolvedFor(aware, request).length, 0)

      await aware.answer(request, { decision: 'decline' })
      assert.equal((await aware.completed(turn.id)).status, 'completed')
      assert.deepEqual(decisions, [{ decision: 'decline' }])
      assert.equal(resolvedFor(aware, request).length, 1)
    })
})

test('MULTI-REQ-006：订阅连接全都走了，审批照旧一直等；新连接握手时被告知，订阅后收到并回答', async () => {
  await withStage('multi-unattended', async (stage) => {
    const { plain, aware, threadId } = await mixed(stage)
    const decisions: PermissionDecision[] = []
    stage.script = commandNeedingApproval(decisions)
    const { turn } = await plain.request('turn/start', { threadId, input: text('跑一条命令') })
    const original = await plain.serverRequest(COMMAND)
    await aware.serverRequest(COMMAND)
    plain.disconnect()
    await settle()
    assert.deepEqual(decisions, [], '走了一条，另一条还在看，不算无人在看')
    aware.disconnect()
    await settle()
    assert.deepEqual(decisions, [], '无人在看时不当作拒绝，一直等')

    const back = await stage.connect('back')
    const announced = await back.notification('thread/status/changed')
    assert.deepEqual(announced.params, {
      threadId,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    })
    assert.equal(back.requests().length, 0, '没订阅之前收不到请求')
    await back.request('thread/resume', { threadId })
    const replayed = await back.serverRequest(COMMAND)
    assert.deepEqual(
      { id: replayed.id, params: replayed.params },
      { id: original.id, params: original.params },
    )
    await back.answer(replayed, { decision: 'accept' })
    assert.equal((await back.completed(turn.id)).status, 'completed')
    assert.deepEqual(decisions, [{ decision: 'accept' }])
  })
})
