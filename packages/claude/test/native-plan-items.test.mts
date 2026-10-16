import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 计划确认由入口在回合里问，是握手时声明了 planConfirmation 扩展的客户端（Litch）才有的；
// 没声明的客户端（官方桌面端）入口不问，见 native-plan-desktop.test.mts。
const PLAN_CONFIRMATION = { litchExtensions: ['planConfirmation'] }

// 计划模式里模型交计划（ExitPlanMode）的那个回合，客户端看到的条目（真实 CLI）。
// 问用户“执行还是继续规划”的那一条就是这次工具调用的条目，和 AskUserQuestion 一样只有一条；
// 计划条目里只有计划，交出计划之后模型说的话是单独的回答；实时收到的和 thread/read 读回的一样。

const PLAN = '# 计划\n\n1. 第一步\n2. 第二步'
type Answer = '执行计划' | '继续规划'
const replyTo = (answer: Answer) => (answer === '执行计划' ? '开始执行。' : '好，先不动手。')

function promptText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(promptText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(promptText).join('\n')
  return ''
}

// 模型直接把计划说出来，紧接着交计划：计划模式由会话设置打开。
function spokenPlan(model: MockLLM, answer: Answer): void {
  model.enqueue(() => [
    { type: 'text', text: PLAN },
    { type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: {} },
  ])
  model.enqueue(() => [{ type: 'text', text: replyTo(answer) }])
}

async function planTurn(
  answer: Answer,
  script: (model: MockLLM, answer: Answer) => void = spokenPlan,
  planByTool = false,
) {
  const home = await mkdtemp(join(tmpdir(), 'native-plan-items-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    PLAN_CONFIRMATION,
  )
  try {
    let asked = 0
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      asked++
      return { answers: { [params.questions[0].id]: { answers: [answer] } } }
    }
    script(model, answer)
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':workspace',
    })
    if (!planByTool)
      await client.request('thread/settings/update', {
        threadId: thread.id,
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'claude-sonnet-4-6',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '出个计划' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
    assert.equal(asked, 1)
    const live = client.trace
      .filter((x) => x.method === 'item/completed' && x.params.turnId === turn.id)
      .map((x) => x.params.item)
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const stored = read.thread.turns
      .find((entry: any) => entry.id === turn.id)
      .items.filter((item: any) => item.type !== 'userMessage')
    return { live, stored }
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const sameAsStored = (live: any[], stored: any[]) =>
  assert.deepEqual(
    [...live].sort((a, b) => a.id.localeCompare(b.id)),
    [...stored].sort((a, b) => a.id.localeCompare(b.id)),
  )

for (const answer of ['继续规划', '执行计划'] as const) {
  test(`PLAN-006：交计划只有一条工具条目，选“${answer}”不是失败`, { timeout: 60_000 }, async () => {
    const { live, stored } = await planTurn(answer)
    const tools = stored.filter((item: any) =>
      ['mcpToolCall', 'dynamicToolCall', 'commandExecution'].includes(item.type),
    )
    assert.deepEqual(
      tools.map((item: any) => [item.type, item.namespace, item.tool, item.status, item.success]),
      [['dynamicToolCall', 'claude', 'ExitPlanMode', 'completed', true]],
    )
    assert.equal(tools[0].contentItems[0].text, `执行计划: ${answer}`)
    sameAsStored(live, stored)
  })
}

const texts = (stored: any[], type: string) =>
  stored.filter((item: any) => item.type === type).map((item: any) => item.text)

for (const answer of ['继续规划', '执行计划'] as const) {
  test(`PLAN-007：计划条目里只有计划，选“${answer}”之后说的话是单独的回答`, {
    timeout: 60_000,
  }, async () => {
    const { live, stored } = await planTurn(answer)
    assert.deepEqual(texts(stored, 'plan'), [PLAN])
    assert.deepEqual(texts(stored, 'agentMessage'), [replyTo(answer)])
    assert.equal(stored.find((item: any) => item.type === 'agentMessage').phase, 'final_answer')
    // 计划条目在问用户之前就收尾了
    const order = live.map((item: any) => item.type)
    assert.ok(order.indexOf('plan') < order.indexOf('dynamicToolCall'), order.join())
    sameAsStored(live, stored)
  })
}

// 模型自己进计划模式、把计划写进计划文件，再说一句、交计划：计划条目就是文件的内容。
function writtenPlan(model: MockLLM, answer: Answer): void {
  model.enqueue(() => [{ type: 'tool_use', id: 'toolu_enter', name: 'EnterPlanMode', input: {} }])
  model.enqueue((request) => {
    const location = /create your plan at ([^\n]+?) using the Write tool/.exec(
      promptText(request.messages),
    )
    assert.ok(location, 'CLI 必须向模型提供真实计划路径')
    return [
      {
        type: 'tool_use',
        id: 'toolu_plan_file',
        name: 'Write',
        input: { file_path: location[1], content: PLAN },
      },
    ]
  })
  model.enqueue(() => [
    { type: 'text', text: '计划写在文件里了，请过目。' },
    { type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: {} },
  ])
  model.enqueue(() => [{ type: 'text', text: replyTo(answer) }])
}

test('PLAN-008：写进计划文件之后说的话不并进计划条目', { timeout: 60_000 }, async () => {
  const { live, stored } = await planTurn('继续规划', writtenPlan, true)
  assert.deepEqual(texts(stored, 'plan'), [PLAN])
  assert.deepEqual(texts(stored, 'agentMessage'), ['计划写在文件里了，请过目。', '好，先不动手。'])
  sameAsStored(live, stored)
})
