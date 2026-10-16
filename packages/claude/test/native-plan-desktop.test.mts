import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  backgroundBash,
  lastUserText,
  say,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { descendants, killAll } from './fixtures/process-tree.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 计划确认交给客户端的那一边（真实 CLI）：握手时没声明 planConfirmation 的客户端（官方桌面端、移动端）
// 自己在回合结束后问“要不要执行”，入口不再问一次。照官方桌面端的请求序列走：
// 计划模式的回合带着计划条目正常结束（completed）；选“执行”是一个协作模式切回 default 的新回合，
// 用户消息是固定的一行加计划全文；写意见是计划模式里的普通跟进消息，模型改了计划再交一次。
// 桌面端的做法见 research/codex-desktop-analysis-2026-10-12/04-composer-approvals-plan.md 第 2.6.4 节。

const PLAN = '# 计划\n\n1. 写 done.txt\n2. 读回来核对'
const REVISED = '# 计划（改过）\n\n1. 先备份\n2. 写 done.txt'
const IMPLEMENT = 'PLEASE IMPLEMENT THIS PLAN:'

const tool = (name: string, id: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

function promptText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(promptText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(promptText).join('\n')
  return ''
}

function toolResult(request: ModelRequest, id: string): any {
  return request.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)
}

const collaboration = (mode: 'plan' | 'default') => ({
  mode,
  settings: { model: 'claude-sonnet-4-6', reasoning_effort: null, developer_instructions: null },
})

/** 这个回合实时收到的、收尾了的条目 */
const itemsOf = (client: ProtocolClient, turnId: string): any[] =>
  client.trace
    .filter((x) => x.method === 'item/completed' && x.params.turnId === turnId)
    .map((x) => x.params.item)

/** 桌面端拿来问的那份计划：回合里最后一个计划条目的字（去掉首尾空白） */
const lastPlan = (client: ProtocolClient, turnId: string): string | null =>
  itemsOf(client, turnId)
    .filter((item) => item.type === 'plan')
    .at(-1)
    ?.text.trim() ?? null

const modeNow = (client: ProtocolClient): string | undefined =>
  client.trace.filter((x) => x.method === 'thread/settings/updated').at(-1)?.params.threadSettings
    .collaborationMode.mode

async function desktop(name: string) {
  const home = await mkdtemp(join(tmpdir(), `native-plan-desktop-${name}-`))
  const model = new MockLLM()
  // 握手时什么扩展都不声明，和官方桌面端一样
  const client = await ProtocolClient.start(home, await model.start())
  const asked: string[] = []
  client.onServerRequest = async (method) => {
    asked.push(method)
    throw new Error(`入口不该向没声明 planConfirmation 的客户端发请求：${method}`)
  }
  const { thread } = await client.request('thread/start', {
    cwd: home,
    permissions: ':danger-full-access',
  })
  const turn = async (text: string, mode?: 'plan' | 'default') => {
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text }],
      ...(mode ? { collaborationMode: collaboration(mode) } : {}),
    })
    return { id: turn.id as string, done: await client.completed(turn.id) }
  }
  const close = async () => {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  return { home, model, client, thread, turn, asked, close }
}

test('PLAN-DESKTOP-001：没声明扩展的客户端，交计划时入口不问；写意见改计划、选执行都照桌面端发来的请求做', {
  timeout: 90_000,
}, async () => {
  const d = await desktop('spoken')
  const done = join(d.home, 'done.txt')
  try {
    // 计划模式的回合：模型把计划说出来，紧接着交计划
    d.model.enqueue(() => [{ type: 'text', text: PLAN }, tool('ExitPlanMode', 'toolu_exit', {})])
    const planned = await d.turn('出个计划', 'plan')
    // 回合带着计划正常结束：桌面端只在 completed 的回合里找计划来问
    assert.equal(planned.done.status, 'completed', JSON.stringify(planned.done))
    assert.equal(planned.done.error, null)
    assert.equal(lastPlan(d.client, planned.id), PLAN)
    // 交计划之后没有再请求模型，也没有问用户
    assert.equal(d.model.requests.length, 1)
    assert.deepEqual(d.asked, [])
    assert.ok(
      !itemsOf(d.client, planned.id).some((item) => item.type === 'dynamicToolCall'),
      '没问用户，就没有提问的条目',
    )
    // 入口没有自己退出计划模式（退出的话会告诉客户端协作模式成了 default）：要不要执行由客户端问
    assert.notEqual(modeNow(d.client), 'default')
    d.model.assertConsumed()

    // 写意见：计划模式里的普通跟进消息，模型改了计划再交一次，入口还是不问
    d.model.enqueue((request) => {
      assert.match(promptText(request.messages.at(-1)), /先备份/)
      return [{ type: 'text', text: REVISED }, tool('ExitPlanMode', 'toolu_exit_again', {})]
    })
    const revised = await d.turn('动手之前先备份', 'plan')
    assert.equal(revised.done.status, 'completed', JSON.stringify(revised.done))
    assert.equal(lastPlan(d.client, revised.id), REVISED)
    assert.deepEqual(d.asked, [])
    d.model.assertConsumed()

    // 选执行：协作模式切回 default，用户消息是固定的一行加计划全文
    d.model.enqueue((request) => {
      assert.ok(promptText(request.messages.at(-1)).includes(`${IMPLEMENT}\n${REVISED}`))
      return [tool('Write', 'toolu_done', { file_path: done, content: '已执行' })]
    })
    d.model.enqueue((request) => {
      assert.notEqual(toolResult(request, 'toolu_done')?.is_error, true)
      return [{ type: 'text', text: '照计划做完了' }]
    })
    const implemented = await d.turn(`${IMPLEMENT}\n${lastPlan(d.client, revised.id)}`, 'default')
    assert.equal(implemented.done.status, 'completed', JSON.stringify(implemented.done))
    // 写得进去：回合按客户端要的默认模式跑了
    assert.equal(await readFile(done, 'utf8'), '已执行')
    assert.deepEqual(d.asked, [])
    d.model.assertConsumed()

    // 读回来和实时收到的一样：交计划的两个回合都是计划条目收尾、状态 completed
    const read = await d.client.request('thread/read', {
      threadId: d.thread.id,
      includeTurns: true,
    })
    assert.deepEqual(
      read.thread.turns.map((turn: any) => [
        turn.status,
        turn.items.filter((item: any) => item.type === 'plan').map((item: any) => item.text),
      ]),
      [
        ['completed', [PLAN]],
        ['completed', [REVISED]],
        ['completed', []],
      ],
    )
  } finally {
    await d.close()
  }
})

test('PLAN-DESKTOP-002：模型自己进计划模式、写进计划文件再交：入口不问，计划条目是文件的内容', {
  timeout: 90_000,
}, async () => {
  const d = await desktop('file')
  const done = join(d.home, 'done.txt')
  try {
    d.model.enqueue(() => [tool('EnterPlanMode', 'toolu_enter', {})])
    d.model.enqueue((request) => {
      const location = /create your plan at ([^\n]+?) using the Write tool/.exec(
        promptText(request.messages),
      )
      assert.ok(location, 'CLI 必须向模型提供真实计划路径')
      return [tool('Write', 'toolu_plan_file', { file_path: location[1], content: PLAN })]
    })
    d.model.enqueue(() => [
      { type: 'text', text: '计划写在文件里了，请过目。' },
      tool('ExitPlanMode', 'toolu_exit', {}),
    ])
    const planned = await d.turn('先做个计划再动手')
    assert.equal(planned.done.status, 'completed', JSON.stringify(planned.done))
    assert.equal(lastPlan(d.client, planned.id), PLAN.trim())
    assert.deepEqual(d.asked, [])
    // 模型自己进的计划模式，入口告诉过客户端
    assert.equal(modeNow(d.client), 'plan')
    d.model.assertConsumed()

    d.model.enqueue(() => [tool('Write', 'toolu_done', { file_path: done, content: '已执行' })])
    d.model.enqueue((request) => {
      assert.notEqual(toolResult(request, 'toolu_done')?.is_error, true)
      return [{ type: 'text', text: '做完了' }]
    })
    const implemented = await d.turn(`${IMPLEMENT}\n${lastPlan(d.client, planned.id)}`, 'default')
    assert.equal(implemented.done.status, 'completed', JSON.stringify(implemented.done))
    assert.equal(await readFile(done, 'utf8'), '已执行')
    assert.deepEqual(d.asked, [])
    d.model.assertConsumed()
  } finally {
    await d.close()
  }
})

test('PLAN-DESKTOP-003：计划是前一个回合写进计划文件的，这一回合只交计划：补一个计划条目放文件的内容', {
  timeout: 90_000,
}, async () => {
  const d = await desktop('earlier')
  try {
    // 头一个回合：写好计划文件，先问一句，不交计划
    d.model.enqueue(() => [tool('EnterPlanMode', 'toolu_enter', {})])
    d.model.enqueue((request) => {
      const location = /create your plan at ([^\n]+?) using the Write tool/.exec(
        promptText(request.messages),
      )
      assert.ok(location, 'CLI 必须向模型提供真实计划路径')
      return [tool('Write', 'toolu_plan_file', { file_path: location[1], content: PLAN })]
    })
    d.model.enqueue(() => [{ type: 'text', text: '动手之前要不要先备份？' }])
    const asking = await d.turn('先做个计划')
    assert.equal(asking.done.status, 'completed', JSON.stringify(asking.done))
    d.model.assertConsumed()

    // 第二个回合：用户答了，模型直接交计划，这一回合里没有说出或写出计划
    d.model.enqueue(() => [tool('ExitPlanMode', 'toolu_exit', {})])
    const planned = await d.turn('不用备份', 'plan')
    assert.equal(planned.done.status, 'completed', JSON.stringify(planned.done))
    assert.equal(lastPlan(d.client, planned.id), PLAN)
    assert.deepEqual(d.asked, [])
    d.model.assertConsumed()
    // 读回来一样
    const read = await d.client.request('thread/read', {
      threadId: d.thread.id,
      includeTurns: true,
    })
    assert.deepEqual(
      read.thread.turns
        .find((turn: any) => turn.id === planned.id)
        .items.filter((item: any) => item.type === 'plan')
        .map((item: any) => item.text),
      [PLAN],
    )
  } finally {
    await d.close()
  }
})

// CLI 自己开的回合（后台命令结束后把结果告诉模型）不是哪条连接发起的：问不问看这时订阅着线程的连接。
// 订阅着的是 Litch（声明了）就照旧在回合里问；只有官方桌面端这样没声明的连接订阅着，就不问。
async function spontaneousPlan(declared: boolean) {
  const home = await mkdtemp(join(tmpdir(), `native-plan-spontaneous-${declared}-`))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    declared ? { litchExtensions: ['planConfirmation'] } : null,
  )
  const asked: any[] = []
  client.onServerRequest = async (method, params) => {
    asked.push({ method, params })
    if (method !== 'item/tool/requestUserInput') throw new Error(`没想到的请求：${method}`)
    return { answers: { execute_plan: { answers: ['执行计划'] } } }
  }
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':danger-full-access',
    })
    model.enqueue(backgroundBash('toolu_bg', uniqueSleep(1)))
    model.enqueue(say('已在后台启动'))
    // 后台命令结束，CLI 自己开一轮：模型进计划模式、交计划
    model.enqueue((request) => {
      assert.match(lastUserText(request), /task-notification/)
      return [tool('EnterPlanMode', 'toolu_enter', {})]
    })
    model.enqueue(() => [{ type: 'text', text: PLAN }, tool('ExitPlanMode', 'toolu_exit', {})])
    if (declared) model.enqueue(say('照计划做完了'))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '在后台跑一条短命令' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const started = () =>
      client.trace.filter((x) => x.method === 'turn/started').map((x) => x.params.turn.id)
    await until('CLI 自己开的回合开始', () => started().length === 2, 30_000)
    const spontaneous = started()[1] as string
    const done = await client.completed(spontaneous)
    assert.equal(done.status, 'completed', JSON.stringify(done))
    model.assertConsumed()
    return { asked, plan: lastPlan(client, spontaneous), spontaneous }
  } finally {
    const tree = descendants(client.process.pid as number).map((row) => row.pid)
    await client.close()
    await model.close()
    killAll(tree)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('PLAN-DESKTOP-004：CLI 自己开的回合里交计划，订阅着的连接声明了就照旧问，没声明就不问', {
  timeout: 120_000,
}, async () => {
  const litch = await spontaneousPlan(true)
  assert.deepEqual(
    litch.asked.map((x) => [x.method, x.params.turnId, x.params.questions[0].id]),
    [['item/tool/requestUserInput', litch.spontaneous, 'execute_plan']],
  )
  const desk = await spontaneousPlan(false)
  assert.deepEqual(desk.asked, [])
  assert.equal(desk.plan, PLAN)
})
