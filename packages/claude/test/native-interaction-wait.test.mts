import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 计划确认由入口在回合里问，是握手时声明了 planConfirmation 扩展的客户端（Litch）才有的；
// 没声明的客户端（官方桌面端）入口不问，见 native-plan-desktop.test.mts。
const PLAN_CONFIRMATION = { litchExtensions: ['planConfirmation'] }

type InputTool = 'AskUserQuestion' | 'ExitPlanMode'

async function verifyLongWait(toolName: InputTool): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'native-input-wait-'))
  const target = join(home, 'must-not-write.txt')
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    PLAN_CONFIRMATION,
  )
  let release!: () => void, answered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const replied = new Promise<void>((resolve) => {
    answered = resolve
  })
  let requestedAt = 0
  let requestedAtMonotonic = 0
  const requestTimes: Array<{ wall: number; monotonic: number }> = []
  const inputID = 'toolu_delayed_input'
  try {
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      requestedAt = Date.now()
      requestedAtMonotonic = performance.now()
      requestTimes.push({ wall: requestedAt, monotonic: requestedAtMonotonic })
      await held
      answered()
      return {
        answers: {
          [params.questions[0].id]: {
            answers: [toolName === 'ExitPlanMode' ? '继续规划' : 'DELAYED_USER_ANSWER'],
          },
        },
      }
    }
    if (toolName === 'ExitPlanMode')
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_enter_wait_plan',
          name: 'EnterPlanMode',
          input: {},
        },
      ])
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: inputID,
        name: toolName,
        input:
          toolName === 'ExitPlanMode'
            ? {}
            : {
                questions: [
                  {
                    question: 'Which color?',
                    header: 'Color',
                    multiSelect: false,
                    options: [
                      { label: 'Blue', description: 'Use blue' },
                      { label: 'Red', description: 'Use red' },
                    ],
                  },
                ],
              },
      },
    ])
    model.enqueue((request) => {
      const results = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((block: any) => block.type === 'tool_result' && block.tool_use_id === inputID)
      assert.equal(results.length, 1, '真实 CLI 必须收到唯一用户确认结果')
      assert.equal(results[0].is_error === true, toolName === 'ExitPlanMode')
      if (toolName === 'AskUserQuestion')
        assert.match(JSON.stringify(results[0]), /DELAYED_USER_ANSWER/)
      if (toolName === 'ExitPlanMode')
        return [
          {
            type: 'tool_use',
            id: 'toolu_after_decline_write',
            name: 'Write',
            input: { file_path: target, content: '禁止未确认计划产生副作用' },
          },
        ]
      return [{ type: 'text', text: 'DELAYED_ANSWER_HANDLED' }]
    })
    if (toolName === 'ExitPlanMode')
      model.enqueue((request) => {
        const results = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .filter(
            (block: any) =>
              block.type === 'tool_result' && block.tool_use_id === 'toolu_after_decline_write',
          )
        assert.equal(results.length, 1)
        assert.equal(results[0].is_error, true, '长等待后拒绝退出计划，真实 Write 仍被计划权限拒绝')
        return [{ type: 'text', text: 'PLAN_DECLINE_HANDLED' }]
      })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '等待真实用户回答，不得猜测或自动确认' }],
    })
    await client.notification('item/tool/requestUserInput')
    // 真正跨过原120秒边界；此处仅为测试等待，不改变产品时钟或计时参数。
    await new Promise((resolve) => setTimeout(resolve, 125_000))
    const elapsedMs = Date.now() - requestedAt
    const timing = {
      toolName,
      requestedAt,
      elapsedMs,
      monotonicElapsedMs: performance.now() - requestedAtMonotonic,
      requestTimes,
      modelRequests: model.requests.length,
    }
    await saveArtifact('native-input-wait-clock', timing)
    // 要守的是跨过 120 秒：定时器按事件循环缓存的单调时间算，这里比的是墙上的钟，机器忙时
    // 会差十几毫秒（实测过 124988 ms），多睡的 5 秒是给这个留的余量
    assert.ok(requestedAt > 0 && elapsedMs >= 120_000, JSON.stringify(timing))
    assert.equal(client.trace.filter((event) => event.method === 'turn/completed').length, 0)
    assert.equal(
      client.trace.filter((event) => event.method === 'serverRequest/resolved').length,
      0,
    )
    assert.equal(model.requests.length, toolName === 'ExitPlanMode' ? 2 : 1)
    await assert.rejects(access(target), { code: 'ENOENT' })
    release()
    await replied
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const terminal = client.trace.find(
      (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
    )
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const stored = history.thread.turns[0]
    const input = stored.items.find(
      (item: any) => item.type === 'dynamicToolCall' && item.tool === toolName,
    )
    const request = client.trace.find((event) => event.method === 'item/tool/requestUserInput')
    const resolved = client.trace.filter(
      (event) => event.method === 'serverRequest/resolved' && event.params.requestId === request.id,
    )
    const starts = client.trace.filter(
      (event) => event.method === 'item/started' && event.params.turnId === turn.id,
    )
    const ends = client.trace.filter(
      (event) => event.method === 'item/completed' && event.params.turnId === turn.id,
    )
    await saveArtifact('native-input-long-wait', {
      toolName,
      elapsedMs,
      threadId: thread.id,
      turnId: turn.id,
      requestId: request.id,
      modelRequests: model.requests.length,
      status: stored.status,
      items: stored.items.map((item: any) => ({
        id: item.id,
        type: item.type,
        tool: item.tool,
        status: item.status,
        success: item.success,
      })),
      startedIDs: starts.map((event) => event.params.item.id),
      completedIDs: ends.map((event) => event.params.item.id),
    })
    assert.equal(history.thread.status.type, 'idle')
    assert.equal(input.status, 'completed', '明确回答后提问条目必须完成')
    assert.equal(input.success, true)
    assert.doesNotMatch(JSON.stringify(input.contentItems), /超时/)
    assert.ok(stored.items.every((item: any) => item.status !== 'inProgress'))
    assert.equal(resolved.length, 1)
    const terminalIndex = client.trace.indexOf(terminal)
    const inputEnd = ends.filter((event) => event.params.item.id === input.id)
    assert.equal(inputEnd.length, 1)
    assert.ok(client.trace.indexOf(resolved[0]) < client.trace.indexOf(inputEnd[0]))
    assert.ok(client.trace.indexOf(inputEnd[0]) < terminalIndex)
    assert.equal(new Set(starts.map((event) => event.params.item.id)).size, starts.length)
    assert.equal(new Set(ends.map((event) => event.params.item.id)).size, ends.length)
    assert.deepEqual(
      starts.map((event) => event.params.item.id).sort(),
      ends.map((event) => event.params.item.id).sort(),
    )
    assert.ok(ends.every((event) => client.trace.indexOf(event) < terminalIndex))
    assert.equal(
      client.trace.filter(
        (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
      ).length,
      1,
    )
    await assert.rejects(access(target), { code: 'ENOENT' })
    assert.equal(
      model.requests.length,
      toolName === 'ExitPlanMode' ? 4 : 2,
      '明确回答后模型只能继续一次',
    )
    if (toolName === 'ExitPlanMode') {
      await client.request('thread/resume', { threadId: thread.id })
      const settings = client.trace
        .filter((event) => event.method === 'thread/settings/updated')
        .at(-1)
      assert.equal(settings.params.threadSettings.collaborationMode.mode, 'plan')
    }
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('APPROVAL-007 / EVENTS-006：真实提问与退出计划等待超过120秒仍可回答，权限与事件历史正确', {
  timeout: 210_000,
}, async () => {
  // 独立 HOME/模型/适配器并发验证，避免串行叠加等待时间。
  const results = await Promise.allSettled([
    verifyLongWait('AskUserQuestion'),
    verifyLongWait('ExitPlanMode'),
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length) throw new AggregateError(failures, '真实交互长等待验收失败')
})
