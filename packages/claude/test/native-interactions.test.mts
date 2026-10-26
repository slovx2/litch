import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openAIOnlyRequests } from './fixtures/capability-cases.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 计划确认由入口在回合里问，是握手时声明了 planConfirmation 扩展的客户端（Litch）才有的；
// 没声明的客户端（官方桌面端）入口不问，见 native-plan-desktop.test.mts。
const PLAN_CONFIRMATION = { litchExtensions: ['planConfirmation'] }

import { askAnswerContent } from '../src/user-questions.mjs'
import { validatePayload } from './fixtures/schema-contract.mjs'

interface AskedQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description: string }>
}

// 模型出的一道题，照 AskUserQuestion 的入参写。
const asked = (
  question: string,
  header: string,
  labels: string[],
  multiSelect = false,
): AskedQuestion => ({
  question,
  header,
  multiSelect,
  options: labels.map((label) => ({ label, description: `选 ${label}` })),
})

const askTool = (id: string, questions: AskedQuestion[]) => ({
  type: 'tool_use',
  id,
  name: 'AskUserQuestion',
  input: { questions },
})

const tool = (name: string, id: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

// 这道题到了客户端应该是什么样：标识按顺序编，选项原样，一个不多一个不少，
// “选项之外自己说”只用 isOther 表示。
const wireQuestion = (question: AskedQuestion, index: number) => ({
  id: `q${index}`,
  header: question.header,
  question: question.question,
  isOther: true,
  isSecret: false,
  options: question.options,
})

// 模型在下一次请求里看到的那条工具结果。
function toolResult(request: ModelRequest, id: string): { is_error?: boolean; text: string } {
  const block = request.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((entry: any) => entry.type === 'tool_result' && entry.tool_use_id === id)
  assert.ok(block, `模型没有收到工具结果 ${id}`)
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  return { is_error: block.is_error, text }
}

// 一个回合里提问条目的开始、结束，和历史里存下来的那一份。
async function questionItem(client: ProtocolClient, threadId: string, turnId: string) {
  const mine = (event: any) =>
    event.params?.turnId === turnId && event.params.item?.type === 'dynamicToolCall'
  const starts = client.trace.filter((event) => event.method === 'item/started' && mine(event))
  const ends = client.trace.filter((event) => event.method === 'item/completed' && mine(event))
  const history = await client.request('thread/read', { threadId, includeTurns: true })
  const turn = history.thread.turns.find((entry: any) => entry.id === turnId)
  const stored = turn.items.filter((item: any) => item.type === 'dynamicToolCall')
  return { starts, ends, stored, turn, thread: history.thread }
}

test('CAPABILITY-001：OpenAI 专属能力明确拒绝且不触发模型', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-capability-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    for (const [method, params] of openAIOnlyRequests) {
      validatePayload(method, 'Params', params)
      const response = await client.raw(method, params)
      assert.equal(response.error.code, -32004, method)
      assert.equal(response.result, undefined)
    }
    assert.deepEqual(await client.request('account/read', {}), {
      account: null,
      requiresOpenaiAuth: false,
    })
    const catalog = await client.request('model/list', { limit: 100 })
    validatePayload('model/list', 'Response', catalog)
    assert.ok(catalog.data.length > 0)
    for (const option of catalog.data) {
      // 手机参数面板依赖完整的 0.157.1 模型字段；Claude 不伪装 OpenAI 服务等级。
      assert.deepEqual(option.serviceTiers, [])
      assert.equal(option.defaultServiceTier, null)
      assert.equal(option.modelSpecialty, null)
      assert.ok(option.supportedReasoningEfforts.length > 0)
    }
    assert.equal((await client.raw('unknown/protocol')).error.code, -32601)
    assert.equal(
      (await client.raw('thread/start', { cwd: home, model: 'gpt-5.6' })).error.code,
      -32602,
    )
    assert.equal(model.requests.length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('APPROVAL-003：真实 AskUserQuestion 回调答案进入下一轮模型上下文', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-question-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    let answers = 0
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      assert.equal(params.questions.length, 1)
      answers++
      return { answers: { [params.questions[0].id]: { answers: ['Blue'] } } }
    }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_question',
        name: 'AskUserQuestion',
        input: {
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
        .filter((block: any) => block.type === 'tool_result')
      assert.match(JSON.stringify(results), /Blue/)
      return [{ type: 'text', text: 'SELECTED_BLUE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Ask the color' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(answers, 1)
    assert.equal(client.trace.filter((item) => item.method === 'serverRequest/resolved').length, 1)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('QUESTION-001：一次三道题，选项、跳过、自己写，请求的形状和模型看到的回答逐题对得上', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-question-three-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const questions = [
    asked('装在哪一级？', '范围', ['用户级', '系统级']),
    asked('日志写到哪儿？', '日志', ['文件', '日志服务']),
    asked('什么时候上线？', '时间', ['现在', '以后']),
  ]
  try {
    const requests: any[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      requests.push(params)
      return {
        answers: {
          // 选了一个选项
          q0: { answers: ['系统级'] },
          // 跳过：这道题给空的
          q1: { answers: [] },
          // 选项都不要，自己写了一句
          q2: { answers: ['等发版之后'] },
        },
      }
    }
    let seen: ReturnType<typeof toolResult> | null = null
    model.enqueue(() => [askTool('toolu_three', questions)])
    model.enqueue((request) => {
      seen = toolResult(request, 'toolu_three')
      return [{ type: 'text', text: 'THREE_ANSWERED' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '先问清楚再动手' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')

    // 一次工具调用就是一条请求，三道题都在里面
    assert.equal(requests.length, 1)
    const [request] = requests
    assert.deepEqual(request.questions, questions.map(wireQuestion))
    assert.equal(request.threadId, thread.id)
    assert.equal(request.turnId, turn.id)
    // 默认协作模式：照上游不标 blocking（计划模式的见 native-input-reconnect.test.mts）
    assert.equal(request.isBlocking, false)

    // 模型看到的：答了的两道各带着自己的回答，跳过的那道不在里面（下面是 CLI 自己的写法）
    assert.ok(seen, '模型没有收到提问的结果')
    const result = seen as ReturnType<typeof toolResult>
    assert.notEqual(result.is_error, true)
    assert.ok(result.text.includes('"装在哪一级？"="系统级"'), result.text)
    assert.ok(result.text.includes('"什么时候上线？"="等发版之后"'), result.text)
    assert.ok(!result.text.includes('日志写到哪儿？'), result.text)

    // 提问条目：一开一合，挂在这条请求上；历史里逐题记着回答
    const item = await questionItem(client, thread.id, turn.id)
    assert.equal(item.starts.length, 1)
    assert.equal(item.ends.length, 1)
    assert.equal(request.itemId, item.starts[0].params.item.id)
    assert.deepEqual(item.starts[0].params.item.arguments, { questions: request.questions })
    assert.equal(item.stored.length, 1)
    assert.equal(item.stored[0].tool, 'AskUserQuestion')
    assert.equal(item.stored[0].status, 'completed')
    assert.equal(item.stored[0].success, true)
    assert.deepEqual(item.stored[0].contentItems, [
      { type: 'inputText', text: '范围: 系统级' },
      { type: 'inputText', text: '日志: (no answer)' },
      { type: 'inputText', text: '时间: 等发版之后' },
    ])
    // 读历史（native-history.mts）时只有 CLI 写给模型的这句话：按题面认回来，和实时的条目逐题一样
    assert.deepEqual(
      askAnswerContent({ questions }, request.questions, result.text),
      item.stored[0].contentItems,
    )
    assert.equal(
      client.trace.filter((event) => event.method === 'serverRequest/resolved').length,
      1,
    )
    assert.equal(item.thread.status.type, 'idle')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('QUESTION-002：一道题和四道题；多选题没有标记，交回几个答案都到得了模型', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-question-count-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const one = [asked('用哪种颜色？', '颜色', ['蓝', '红'])]
  const four = [
    asked('第一题？', '一', ['A', 'B']),
    // 标签里带着分隔用的逗号：交回去之后 CLI 还得拆得回原来的几项
    asked('要开哪些功能？', '二', ['C', 'D, d', 'E'], true),
    asked('第三题？', '三', ['F', 'G']),
    asked('通知哪些人？', '四', ['H', 'I'], true),
  ]
  try {
    const requests: any[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      requests.push(params)
      if (params.questions.length === 1) return { answers: { q0: { answers: ['蓝'] } } }
      return {
        answers: {
          q0: { answers: ['A'] },
          // 多选题：一道题交回两个答案
          q1: { answers: ['C', 'D, d'] },
          q2: { answers: ['G'] },
          // 多选题只答了一个
          q3: { answers: ['H'] },
        },
      }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const ask = async (id: string, questions: AskedQuestion[]) => {
      let seen: ReturnType<typeof toolResult> | null = null
      model.enqueue(() => [askTool(id, questions)])
      model.enqueue((request) => {
        seen = toolResult(request, id)
        return [{ type: 'text', text: `ANSWERED_${id}` }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: `问 ${questions.length} 道题` }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      assert.ok(seen, '模型没有收到提问的结果')
      return { turn, result: seen as ReturnType<typeof toolResult> }
    }

    const single = await ask('toolu_one', one)
    assert.deepEqual(requests[0].questions, one.map(wireQuestion))
    assert.ok(single.result.text.includes('"用哪种颜色？"="蓝"'), single.result.text)

    const many = await ask('toolu_four', four)
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1].questions, four.map(wireQuestion))
    // 协议的题目上没有多选的标记：多选题和单选题的字段一样多
    for (const question of requests[1].questions)
      assert.deepEqual(Object.keys(question).sort(), [
        'header',
        'id',
        'isOther',
        'isSecret',
        'options',
        'question',
      ])
    assert.notEqual(many.result.is_error, true)
    const text = many.result.text
    assert.ok(text.includes('"第一题？"="A"'), text)
    // 几个答案按 CLI 的写法连起来，带逗号的那一项括着
    assert.ok(text.includes('"要开哪些功能？"="C, "D, d""'), text)
    assert.ok(text.includes('"第三题？"="G"'), text)
    assert.ok(text.includes('"通知哪些人？"="H"'), text)
    const item = await questionItem(client, thread.id, many.turn.id)
    assert.deepEqual(
      item.stored[0].contentItems.map((entry: any) => entry.text),
      ['一: A', '二: C, "D, d"', '三: G', '四: H'],
    )
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('QUESTION-003：模型自己写的 Other 选项选得上，用户自己写的字正好是 Other 也原样交回', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-question-other-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const questions = [
    // 工具说明让模型别自己列 Other，但它列了也得照它的意思办：这是一个正经的选项
    asked('归到哪一类？', '分类', ['Bug', 'Feature', 'Other']),
    asked('要不要通知？', '通知', ['要', '不要']),
  ]
  try {
    const requests: any[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      requests.push(params)
      return {
        answers: {
          // 选了模型写的那个 Other
          q0: { answers: ['Other'] },
          // 没选选项，自己写了一个词，正好也是 Other
          q1: { answers: ['Other'] },
        },
      }
    }
    let seen: ReturnType<typeof toolResult> | null = null
    model.enqueue(() => [askTool('toolu_other', questions)])
    model.enqueue((request) => {
      seen = toolResult(request, 'toolu_other')
      return [{ type: 'text', text: 'OTHER_ANSWERED' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '分个类' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    // 选项是模型写的那几个：它的 Other 还在，引擎没有另外补一个
    assert.deepEqual(requests[0].questions, questions.map(wireQuestion))
    assert.deepEqual(
      requests[0].questions[0].options.filter((option: any) => option.label === 'Other'),
      [{ label: 'Other', description: '选 Other' }],
    )
    assert.ok(seen, '模型没有收到提问的结果')
    const result = seen as ReturnType<typeof toolResult>
    assert.notEqual(result.is_error, true)
    assert.ok(result.text.includes('"归到哪一类？"="Other"'), result.text)
    assert.ok(result.text.includes('"要不要通知？"="Other"'), result.text)
    const item = await questionItem(client, thread.id, turn.id)
    assert.deepEqual(
      item.stored[0].contentItems.map((entry: any) => entry.text),
      ['分类: Other', '通知: Other'],
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('QUESTION-004：回合被打断时提问作废，不留悬着的请求和条目，迟到的回答无效', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-question-cut-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    let asks = 0
    client.onServerRequest = async (method) => {
      assert.equal(method, 'item/tool/requestUserInput')
      asks++
      // 第一次的提问一直不答，等回合被打断之后才交卷
      if (asks === 1) await held
      return {
        answers: { q0: { answers: ['蓝'] }, q1: { answers: [] }, q2: { answers: ['晚点'] } },
      }
    }
    const three = [
      asked('用哪种颜色？', '颜色', ['蓝', '红']),
      asked('日志写到哪儿？', '日志', ['文件', '日志服务']),
      asked('什么时候上线？', '时间', ['现在', '以后']),
    ]
    model.enqueue(() => [askTool('toolu_cut', three)])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '问到一半被打断' }],
    })
    const pending = await client.notification('item/tool/requestUserInput')
    const request = client.trace.find((event) => event.method === 'item/tool/requestUserInput')
    // 停在这儿等人：会话的状态如实标着
    await client.notification(
      'thread/status/changed',
      (params) =>
        params.threadId === thread.id &&
        params.status.type === 'active' &&
        params.status.activeFlags.includes('waitingOnUserInput'),
    )
    await client.request('turn/interrupt', { threadId: thread.id, turnId: first.turn.id })
    assert.equal((await client.completed(first.turn.id)).status, 'interrupted')

    // 请求收回了：客户端收到恰好一条“已了结”，卡片可以撤掉
    const resolved = () =>
      client.trace.filter(
        (event) =>
          event.method === 'serverRequest/resolved' && event.params.requestId === request.id,
      )
    assert.equal(resolved().length, 1)
    // 这时候才交的卷不算数
    release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const cut = await questionItem(client, thread.id, first.turn.id)
    assert.equal(cut.turn.status, 'interrupted')
    assert.equal(cut.starts.length, 1)
    assert.equal(cut.starts[0].params.item.id, pending.itemId)
    assert.equal(cut.ends.length, 1, '被打断的提问条目只能有一个终态')
    assert.ok(cut.turn.items.every((item: any) => item.status !== 'inProgress'))
    // 条目落成“没有问成”，不是“答完了”
    assert.equal(cut.stored[0].status, 'failed')
    assert.equal(cut.stored[0].success, false)
    assert.equal(cut.thread.status.type, 'idle')
    assert.equal(resolved().length, 1)
    assert.equal(model.requests.length, 1, '打断和迟到的回答都不能让模型接着跑')

    // 同一个会话接着还能问、能答，前一次的提问没有挡在路上
    let seen: ReturnType<typeof toolResult> | null = null
    model.enqueue(() => [askTool('toolu_again', three)])
    model.enqueue((next) => {
      seen = toolResult(next, 'toolu_again')
      return [{ type: 'text', text: 'ASKED_AGAIN' }]
    })
    const second = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '重新问一遍' }],
    })
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    assert.equal(asks, 2)
    assert.ok(seen, '模型没有收到提问的结果')
    const result = seen as ReturnType<typeof toolResult>
    assert.ok(result.text.includes('"用哪种颜色？"="蓝"'), result.text)
    assert.ok(result.text.includes('"什么时候上线？"="晚点"'), result.text)
    assert.equal(
      client.trace.filter((event) => event.method === 'serverRequest/resolved').length,
      2,
    )
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PLAN-004：计划确认时自己写的话不算确认，原话随拒绝交给模型；选了“执行计划”才放行', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-plan-words-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    PLAN_CONFIRMATION,
  )
  const blocked = join(home, 'blocked.txt')
  const done = join(home, 'done.txt')
  const words = '先把第二步改成只读检查'
  try {
    const requests: any[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      requests.push(params)
      // 第一次没选选项，写了一句对计划的意见；第二次才选“执行计划”
      return {
        answers: { execute_plan: { answers: [requests.length === 1 ? words : '执行计划'] } },
      }
    }
    const seen: Record<string, ReturnType<typeof toolResult>> = {}
    model.enqueue(() => [tool('EnterPlanMode', 'toolu_enter', {})])
    model.enqueue(() => [tool('ExitPlanMode', 'toolu_exit_words', {})])
    model.enqueue((request) => {
      seen.words = toolResult(request, 'toolu_exit_words')
      return [tool('Write', 'toolu_blocked', { file_path: blocked, content: '不该写出来' })]
    })
    model.enqueue((request) => {
      seen.blocked = toolResult(request, 'toolu_blocked')
      return [tool('ExitPlanMode', 'toolu_exit_confirmed', {})]
    })
    model.enqueue((request) => {
      seen.confirmed = toolResult(request, 'toolu_exit_confirmed')
      return [tool('Write', 'toolu_done', { file_path: done, content: '已执行' })]
    })
    model.enqueue((request) => {
      seen.done = toolResult(request, 'toolu_done')
      return [{ type: 'text', text: 'PLAN_EXECUTED' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '先做计划，确认后再执行' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')

    // 两次问的是同一道题：引擎自己出的，两个选项，另外能自己写
    assert.equal(requests.length, 2)
    for (const request of requests)
      assert.deepEqual(request.questions, [
        {
          id: 'execute_plan',
          header: '执行计划',
          question: '计划已完成，是否退出计划模式并按当前权限执行？',
          isOther: true,
          isSecret: false,
          options: [
            { label: '执行计划', description: '退出计划模式，继续执行已确认的计划。' },
            { label: '继续规划', description: '保持计划模式，不执行修改。' },
          ],
        },
      ])
    // 自己写的话：没有放行（这次调用是被拒绝的），但话一个字不差地到了模型
    assert.equal(seen.words?.is_error, true)
    assert.ok(seen.words.text.includes('用户尚未确认执行'), seen.words.text)
    assert.ok(seen.words.text.includes(words), seen.words.text)
    // 还在计划模式里：这时候写文件照样被拦下
    assert.equal(seen.blocked?.is_error, true)
    await assert.rejects(access(blocked))
    // 明确选了“执行计划”才退出计划模式，之后才写得进去
    assert.notEqual(seen.confirmed?.is_error, true)
    assert.notEqual(seen.done?.is_error, true)
    assert.equal(await readFile(done, 'utf8'), '已执行')
    const modes = client.trace
      .filter((event) => event.method === 'thread/settings/updated')
      .map((event) => event.params.threadSettings.collaborationMode.mode)
    assert.deepEqual([modes[0], modes.at(-1)], ['plan', 'default'])
    // 条目上记的是哪个工具在问：界面据此知道这是计划确认，不是模型出的题
    const item = await questionItem(client, thread.id, turn.id)
    assert.deepEqual(
      item.stored.map((entry: any) => [entry.tool, entry.status, entry.contentItems[0].text]),
      [
        ['ExitPlanMode', 'completed', `执行计划: ${words}`],
        ['ExitPlanMode', 'completed', '执行计划: 执行计划'],
      ],
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
