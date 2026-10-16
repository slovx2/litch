import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { type MockBlock, scripted } from './mock-model.mjs'

// dsh 的模型问用户（ask_user_question 工具）：dsh 发来 user-questions/request 瀑布事件，适配器转成
// item/tool/requestUserInput 问客户端，答案交回 dsh，由它写成工具结果给模型。工具调用本身是一个动态工具条目，
// 和 Claude 入口一样。此前这个事件交回 dsh，模型拿到的是“没有人应答”的报错。对着 dsh 0.2.0-rc.2。

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const QUESTIONS = [
  {
    id: 'color',
    question: '用哪种颜色？',
    header: '颜色',
    options: [{ label: '红 (Recommended)', description: '醒目' }, { label: '蓝' }],
  },
  {
    id: 'many',
    question: '要哪些？',
    options: [{ label: '甲' }, { label: '乙' }],
    multi_select: true,
  },
  { id: 'free', question: '叫什么名字？' },
]
// 发给客户端的题：题号是 dsh 的，题头没有的补上，都能自己写，多选的标记带不过去，没有选项的是问答题
const ASKED = [
  {
    id: 'color',
    header: '颜色',
    question: '用哪种颜色？',
    isOther: true,
    isSecret: false,
    options: [
      { label: '红 (Recommended)', description: '醒目' },
      { label: '蓝', description: '' },
    ],
  },
  {
    id: 'many',
    header: 'Question 2',
    question: '要哪些？',
    isOther: true,
    isSecret: false,
    options: [
      { label: '甲', description: '' },
      { label: '乙', description: '' },
    ],
  },
  {
    id: 'free',
    header: 'Question 3',
    question: '叫什么名字？',
    isOther: true,
    isSecret: false,
    options: null,
  },
]

const asking: MockBlock[][] = [
  [{ type: 'tool_use', name: 'ask_user_question', input: { questions: QUESTIONS } }],
  [{ type: 'text', chunks: ['收到。'] }],
]
const respond = scripted({ ASK: asking, AFTER: [[{ type: 'text', chunks: ['接着说。'] }]] })

type Scene = Awaited<ReturnType<typeof isolate>> & {
  home: string
  server: DshServer
  desktop: ReturnType<typeof client>
}

async function scene(): Promise<Scene> {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const home = join(env.root, 'home')
  const server = new DshServer(home)
  const desktop = client(server)
  await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
  return { ...env, home, server, desktop }
}

// 模型收到的这次调用的工具结果：[字, 是不是报错]，还没收到是 null。
function told(s: Scene, callId: string): [string, boolean] | null {
  const block = s.model.requests
    .flatMap((body) => body.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((entry: any) => entry.type === 'tool_result' && entry.tool_use_id === callId)
  if (!block) return null
  const content = Array.isArray(block.content)
    ? block.content.map((entry: any) => entry.text ?? '').join('')
    : String(block.content ?? '')
  return [content, block.is_error === true]
}

// 等客户端收到第 n 个（从 1 数）提问请求。
async function question(c: ReturnType<typeof client>, n = 1): Promise<any> {
  for (let waited = 0; waited < 20000; waited += 20) {
    const found = c.requests.filter((entry) => entry.method === 'item/tool/requestUserInput')
    if (found.length >= n) return found[n - 1]
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等提问请求超时')
}

const finished = (s: Scene, threadId: string, turnId: string) =>
  s.desktop.until(
    'turn/completed',
    (params) => params.threadId === threadId && params.turn.id === turnId,
  )
const asked = (turn: any) => turn.items.find((item: any) => item.type === 'dynamicToolCall')

test('QUESTION-DSH-001：模型问用户，订阅着的客户端都收到提问请求，先答的生效、答案到了模型；条目实时和重读一样', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const other = client(s.server)
    await other.call('initialize', { clientInfo: { name: 'other', version: '0' } })
    s.desktop.onRequest(() => undefined)
    other.onRequest(() => undefined)
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    await other.call('thread/resume', { threadId })
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('ASK 问我') })
    const request = await question(s.desktop)
    // 进程内的连接收到的通知和投影里的条目是同一个对象，留一份当时的样子
    const item = structuredClone(
      (
        await s.desktop.until(
          'item/started',
          (params) => params.turnId === turn.id && params.item.type === 'dynamicToolCall',
        )
      ).item,
    )
    assert.deepEqual(item, {
      type: 'dynamicToolCall',
      id: item.id,
      namespace: 'dsh',
      tool: 'ask_user_question',
      arguments: { questions: ASKED },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    })
    // 有选项的两道和没有选项的那道分两次问（questions-desktop.test.mts 讲了为什么），先问前两道
    assert.deepEqual(request.params, {
      threadId,
      turnId: turn.id,
      itemId: item.id,
      isBlocking: true,
      questions: ASKED.slice(0, 2),
    })
    const waiting = (c: ReturnType<typeof client>) =>
      c.notifications.filter(
        (entry) =>
          entry.method === 'thread/status/changed' &&
          entry.params.threadId === threadId &&
          entry.params.status.activeFlags?.includes('waitingOnUserInput'),
      ).length
    assert.equal(waiting(s.desktop), 1, '等回答时线程在等用户')
    // 另一条订阅着的连接收到的是同一条请求
    const copy = await question(other)
    assert.equal(copy.id, request.id)

    await s.desktop.respond(request, {
      answers: {
        color: { answers: ['蓝'] },
        many: { answers: ['甲', '还有丙'] },
      },
    })
    // 两条连接都知道有结果了；另一条迟到的回答不算数
    for (const c of [s.desktop, other])
      await c.until('serverRequest/resolved', (params) => params.requestId === request.id)
    await other.respond(copy, { answers: {} })
    // 接着问没有选项的那道，挂在同一个工具条目上；这回由另一条连接先答。线程一直标着在等用户，没有断过
    const rest = await question(s.desktop, 2)
    assert.notEqual(rest.id, request.id)
    assert.deepEqual(rest.params, { ...request.params, questions: ASKED.slice(2) })
    assert.equal((await question(other, 2)).id, rest.id)
    assert.equal(waiting(s.desktop), 1)
    await other.respond(rest, { answers: { free: { answers: ['小明'] } } })
    const done = await finished(s, threadId, turn.id)
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    assert.deepEqual(told(s, item.id), [
      JSON.stringify({
        answers: [
          { id: 'color', selected: ['蓝'] },
          { id: 'many', selected: ['甲'], custom: '还有丙' },
          { id: 'free', selected: [], custom: '小明' },
        ],
      }),
      false,
    ])
    const answered = asked(done.turn)
    assert.deepEqual(
      { ...answered, durationMs: null },
      {
        ...item,
        status: 'completed',
        success: true,
        contentItems: [
          { type: 'inputText', text: '颜色: 蓝' },
          { type: 'inputText', text: 'Question 2: 甲, 还有丙' },
          { type: 'inputText', text: 'Question 3: 小明' },
        ],
      },
    )
    assert.equal(typeof answered.durationMs, 'number')
    assert.equal(waiting(s.desktop), 1)

    // 重读、适配器重启后重读，条目一样
    const read = async () =>
      asked((await s.desktop.call('thread/read', { threadId, includeTurns: true })).thread.turns[0])
    assert.deepEqual(await read(), answered)
    await s.server.close()
    s.server = new DshServer(s.home)
    s.desktop = client(s.server)
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    assert.deepEqual(await read(), answered)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('QUESTION-DSH-002：一道都不答（跳过）也是回答：dsh 收到的是每道题都没选、没写', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    // 只有空白的字也算没答
    s.desktop.onRequest((request) =>
      request.method === 'item/tool/requestUserInput'
        ? { answers: { color: { answers: ['  '] } } }
        : {},
    )
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('ASK 问我') })
    const done = await finished(s, threadId, turn.id)
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    const item = asked(done.turn)
    assert.deepEqual(told(s, item.id), [
      JSON.stringify({
        answers: [
          { id: 'color', selected: [] },
          { id: 'many', selected: [] },
          { id: 'free', selected: [] },
        ],
      }),
      false,
    ])
    assert.equal(item.status, 'completed')
    assert.deepEqual(
      item.contentItems.map((entry: any) => entry.text),
      ['颜色: (no answer)', 'Question 2: (no answer)', 'Question 3: (no answer)'],
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('QUESTION-DSH-003：等回答时打断回合，提问在回合结束之前收场，不替用户答，打断之后没有再去问模型', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    s.desktop.onRequest(() => undefined)
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text('ASK 问我') })
    const request = await question(s.desktop)
    await s.desktop.call('turn/interrupt', { threadId, turnId: turn.id })
    const done = await finished(s, threadId, turn.id)
    assert.equal(done.turn.status, 'interrupted')
    const order = s.desktop.notifications.flatMap((entry) =>
      entry.method === 'serverRequest/resolved' && entry.params.requestId === request.id
        ? ['resolved']
        : entry.method === 'turn/completed' && entry.params.turn.id === turn.id
          ? ['completed']
          : [],
    )
    assert.deepEqual(order, ['resolved', 'completed'])
    // 模型那边记的是 dsh 的“用户回答之前就中止了”，打断之后没有再请求模型
    const item = asked(done.turn)
    assert.equal(item.id, request.params.itemId)
    assert.equal(item.status, 'failed')
    assert.equal(item.success, false)
    assert.deepEqual(item.contentItems, [
      { type: 'inputText', text: 'Error: ask_user_question was aborted before the user answered' },
    ])
    assert.equal(told(s, item.id), null)

    // 迟到的回答不算数；会话照常能用，重读出来的一样
    await s.desktop.respond(request, { answers: { color: { answers: ['蓝'] } } })
    const next = await s.desktop.call('turn/start', { threadId, input: text('AFTER 接着说') })
    const after = await finished(s, threadId, next.turn.id)
    assert.equal(after.turn.status, 'completed', JSON.stringify(after.turn.error))
    const { thread } = await s.desktop.call('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(asked(thread.turns[0]), item)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('QUESTION-DSH-004：拿着提问的连接都断了，提问收场、交回 dsh，模型拿到没有人应答，回合接着走完', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const leaving = client(s.server)
    await leaving.call('initialize', { clientInfo: { name: 'leaving', version: '0' } })
    leaving.onRequest(() => undefined)
    const threadId = (await leaving.call('thread/start', { cwd: s.cwd })).thread.id
    const { turn } = await leaving.call('turn/start', { threadId, input: text('ASK 问我') })
    const request = await question(leaving)
    s.server.closePeer(leaving.peer)
    let ended: any = null
    for (let waited = 0; waited < 20000 && !ended; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const { thread } = await s.desktop.call('thread/read', { threadId, includeTurns: true })
      const found = thread.turns.find((entry: any) => entry.id === turn.id)
      if (found?.status !== 'inProgress') ended = found
    }
    assert.equal(ended?.status, 'completed', JSON.stringify(ended))
    const reason = 'Error: no user-questions answerer accepted the request'
    assert.deepEqual(told(s, request.params.itemId), [reason, true])
    const item = asked(ended)
    assert.equal(item.status, 'failed')
    assert.deepEqual(item.contentItems, [{ type: 'inputText', text: reason }])
    assert.ok(
      ended.items.some((entry: any) => entry.type === 'agentMessage' && entry.text === '收到。'),
      '模型接着说完了',
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})
