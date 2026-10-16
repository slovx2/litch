import assert from 'node:assert/strict'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { type MockBlock, scripted } from './mock-model.mjs'

// 官方桌面端（ChatGPT.app 里的 Codex，26.1007.x）答 dsh 入口的提问。对着 dsh 0.2.0-rc.2。
//
// 桌面端交回的形状和上游协议一样：`{answers: {<题号>: {answers: [一个字符串]}}}`，题号就是请求里的 id；
// 选了选项的是那个选项的 label，自己写的是写的字（不加前缀），没答的题整个不出现（不是空数组，和 Litch 不同）。
// 它的提问卡片有一处毛病：同一张卡片里，从“有选项、能自己写（isOther）”的题翻到“没有选项”的题时
// （往前、往回都算），刚才那道题的选择被清掉，交回时那道题就没有了。实际验收里桌面端的日志记着交回的是
// `{"answers":{"q2":{"answers":["日志要留着"]}}}`，第 1 题选的那一项没了。Claude 入口的题都有选项，碰不到。
// 下面的 desktopReply 照这个样子答：形状照它组回答的那一段，毛病照它的提问卡片。

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

type Intent = { pick: string } | { write: string } | { skip: true }

const hasOptions = (question: any) => Array.isArray(question.options) && question.options.length > 0

// 桌面端答一张提问卡片。intents 按题面给用户想怎么答（题号由适配器定，用例不去猜）；
// 卡片里一道一道往下答，答完一道翻到下一道。
function desktopReply(request: any, intents: Record<string, Intent>): any {
  const questions: any[] = request.params.questions
  const state = questions.map(() => ({ selected: null as string | null, text: '' }))
  questions.forEach((question, index) => {
    const intent = intents[question.question]
    if (intent && 'pick' in intent) state[index] = { selected: intent.pick, text: '' }
    else if (intent && 'write' in intent) state[index] = { selected: null, text: intent.write }
    else state[index] = { selected: null, text: '' }
    const next = questions[index + 1]
    // 卡片的毛病：从有选项、能自己写的题翻到没有选项的题，前一题的选择没了
    if (next && hasOptions(question) && question.isOther && !hasOptions(next))
      state[index] = { ...state[index], selected: null } as (typeof state)[number]
  })
  // 组回答：有选项的题取选中的 label，没选中的、能自己写的取写的字；什么都没有的题不出现
  const answers: Record<string, { answers: string[] }> = {}
  questions.forEach((question, index) => {
    const { selected, text } = state[index] as (typeof state)[number]
    let answer = ''
    if (hasOptions(question))
      answer =
        question.options.find((option: any) => option.label === selected)?.label?.trim() ?? ''
    else answer = text.trim()
    if (answer === '' && question.isOther) answer = text.trim()
    if (answer !== '') answers[question.id] = { answers: [answer] }
  })
  // 经过线上的是 JSON：照它的样子过一遍（比如题号是 __proto__ 的那一项在桌面端就带不过来）
  return JSON.parse(JSON.stringify({ answers }))
}

// Litch 答的样子：每道题都有一项，跳过的是空数组（packages/core 的 collectAnswers）
function litchReply(request: any, intents: Record<string, Intent>): any {
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of request.params.questions) {
    const intent = intents[question.question]
    answers[question.id] = {
      answers:
        intent && 'pick' in intent
          ? [intent.pick]
          : intent && 'write' in intent
            ? [intent.write]
            : [],
    }
  }
  return { answers }
}

const options = (...labels: string[]) =>
  labels.map((label) => ({ label, description: `选“${label}”` }))

// 和真实窗口验收里一样的两道题（scripts/client-fixture-anthropic.mjs 给 dsh 出的题），后面再接一道有选项的
const MIXED = [
  {
    id: 'q1',
    question: '这次先动哪一块？',
    header: '范围',
    options: options('只改客户端', '只改适配器', '两边一起改'),
  },
  { id: 'q2', question: '有什么要特别留意的？', header: '留意' },
  { id: 'q3', question: '什么时候发？', header: '时间', options: options('今天', '明天') },
]

// 题号不规整：重复的、空的、__proto__、带各种字符的。dsh 默认的提问工具不查这些（它的限时版才查重复）
const ODD = [
  { id: 'a', question: '第一问', options: options('甲', '乙') },
  { id: 'a', question: '第二问', options: options('丙', '丁') },
  { id: '', question: '第三问', options: options('戊', '己') },
  { id: '__proto__', question: '第四问', options: options('庚', '辛') },
  { id: 'x.y z/题', question: '第五问', options: options('壬', '癸') },
]

const ask = (questions: unknown[]): MockBlock[][] => [
  [{ type: 'tool_use', name: 'ask_user_question', input: { questions } }],
  [{ type: 'text', chunks: ['收到。'] }],
]
const respond = scripted({ MIXED: ask(MIXED), ODD: ask(ODD) })

async function scene() {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(`${env.root}/home`)
  const desktop = client(server)
  await desktop.call('initialize', {
    clientInfo: { name: 'Codex Desktop', version: '26.1007.30912' },
  })
  return { ...env, server, desktop }
}

// 模型收到的这次调用的工具结果（JSON 文本），还没收到是 null
function told(model: { requests: any[] }, callId: string): any {
  const block = model.requests
    .flatMap((body) => body.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((entry: any) => entry.type === 'tool_result' && entry.tool_use_id === callId)
  if (!block) return null
  const content = Array.isArray(block.content)
    ? block.content.map((entry: any) => entry.text ?? '').join('')
    : String(block.content ?? '')
  return JSON.parse(content)
}

async function answered(
  marker: 'MIXED' | 'ODD',
  reply: (request: any) => any,
): Promise<{ result: any; item: any; requests: any[] }> {
  const s = await scene()
  try {
    s.desktop.onRequest((request) =>
      request.method === 'item/tool/requestUserInput' ? reply(request) : {},
    )
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    const { turn } = await s.desktop.call('turn/start', { threadId, input: text(`${marker} 问我`) })
    const done = await s.desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === turn.id,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    const item = done.turn.items.find((entry: any) => entry.type === 'dynamicToolCall')
    // 重读出来的条目和实时的一样
    const { thread } = await s.desktop.call('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(
      thread.turns[0].items.find((entry: any) => entry.type === 'dynamicToolCall'),
      item,
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
    const requests = s.desktop.requests.filter(
      (entry) => entry.method === 'item/tool/requestUserInput',
    )
    return { result: told(s.model, item.id), item, requests }
  } finally {
    await s.server.close()
    await s.restore()
  }
}

// 一张卡片里的题要么都有选项、要么都没有：混在一起就碰上桌面端卡片的毛病
function homogeneous(requests: any[]): void {
  for (const request of requests) {
    const kinds = new Set(request.params.questions.map(hasOptions))
    assert.equal(
      kinds.size,
      1,
      `一张卡片里混了有选项和没有选项的题：${JSON.stringify(request.params.questions)}`,
    )
  }
}

const MIXED_INTENTS: Record<string, Intent> = {
  这次先动哪一块: { pick: '只改适配器' },
  有什么要特别留意的: { write: '日志要留着' },
  什么时候发: { pick: '明天' },
}
// 题面带问号，键也带上
const intents = (map: Record<string, Intent>) =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [`${key}？`, value]))

test('QUESTION-DSH-DESKTOP-001：官方桌面端答有选项和没有选项混在一起的题，选的那项到得了模型', {
  timeout: 180000,
}, async () => {
  const { result, item, requests } = await answered('MIXED', (request) =>
    desktopReply(request, intents(MIXED_INTENTS)),
  )
  assert.deepEqual(result, {
    answers: [
      { id: 'q1', selected: ['只改适配器'] },
      { id: 'q2', selected: [], custom: '日志要留着' },
      { id: 'q3', selected: ['明天'] },
    ],
  })
  homogeneous(requests)
  // 拆成的几张卡片按原来的先后，都挂在同一个工具条目上，题号还是 dsh 的
  assert.deepEqual(
    requests.map((request) => request.params.questions.map((question: any) => question.id)),
    [['q1'], ['q2'], ['q3']],
  )
  for (const request of requests) assert.equal(request.params.itemId, item.id)
  assert.deepEqual(
    item.contentItems.map((entry: any) => entry.text),
    ['范围: 只改适配器', '留意: 日志要留着', '时间: 明天'],
  )
})

test('QUESTION-DSH-DESKTOP-002：官方桌面端跳过没有选项的那道（那道题不出现在回答里），别的题照样到', {
  timeout: 180000,
}, async () => {
  const { result, item } = await answered('MIXED', (request) =>
    desktopReply(
      request,
      intents({
        这次先动哪一块: { pick: '只改适配器' },
        有什么要特别留意的: { skip: true },
        什么时候发: { skip: true },
      }),
    ),
  )
  assert.deepEqual(result, {
    answers: [
      { id: 'q1', selected: ['只改适配器'] },
      { id: 'q2', selected: [] },
      { id: 'q3', selected: [] },
    ],
  })
  assert.deepEqual(
    item.contentItems.map((entry: any) => entry.text),
    ['范围: 只改适配器', '留意: (no answer)', '时间: (no answer)'],
  )
})

test('QUESTION-DSH-DESKTOP-003：同样的题 Litch 答（每道题都有一项，跳过是空数组）也对', {
  timeout: 180000,
}, async () => {
  const { result, requests } = await answered('MIXED', (request) =>
    litchReply(request, intents(MIXED_INTENTS)),
  )
  assert.deepEqual(result, {
    answers: [
      { id: 'q1', selected: ['只改适配器'] },
      { id: 'q2', selected: [], custom: '日志要留着' },
      { id: 'q3', selected: ['明天'] },
    ],
  })
  homogeneous(requests)
})

test('QUESTION-DSH-DESKTOP-004：题号重复、为空、是 __proto__、带各种字符，协议里的题号各不相同，答案按 dsh 的题号逐题对上', {
  timeout: 180000,
}, async () => {
  const picks = { 第一问: '甲', 第二问: '丁', 第三问: '戊', 第四问: '辛', 第五问: '壬' }
  const map = Object.fromEntries(Object.entries(picks).map(([key, pick]) => [key, { pick }]))
  for (const reply of [desktopReply, litchReply]) {
    const { result, item, requests } = await answered('ODD', (request) => reply(request, map))
    assert.deepEqual(result, {
      answers: [
        { id: 'a', selected: ['甲'] },
        { id: 'a', selected: ['丁'] },
        { id: '', selected: ['戊'] },
        { id: '__proto__', selected: ['辛'] },
        { id: 'x.y z/题', selected: ['壬'] },
      ],
    })
    assert.equal(requests.length, 1)
    const ids = requests[0].params.questions.map((question: any) => question.id)
    assert.equal(new Set(ids).size, ids.length, `协议里的题号要各不相同：${JSON.stringify(ids)}`)
    for (const id of ids)
      assert.ok(id !== '' && id !== '__proto__', `题号 ${JSON.stringify(id)} 带不过去`)
    // 规整的题号照用 dsh 的
    assert.equal(ids[0], 'a')
    assert.equal(ids[4], 'x.y z/题')
    assert.deepEqual(
      item.arguments.questions.map((question: any) => question.id),
      ids,
    )
    assert.deepEqual(
      item.contentItems.map((entry: any) => entry.text),
      ['Question 1: 甲', 'Question 2: 丁', 'Question 3: 戊', 'Question 4: 辛', 'Question 5: 壬'],
    )
  }
})
