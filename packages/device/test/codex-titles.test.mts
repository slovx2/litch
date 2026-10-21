// 原生 codex 会话的自动起名（codex-titles.mts）：一台由主进程管着的设备，上面是假的原生 codex（fake-codex.mts，
// 参数照上游的约束核对）。客户端新建会话、第一回合结束，设备进程在自己的连接上开临时会话起名，再写回去。
// CI 上没有 codex；对着真的 codex 只在本机手动验过。
import assert from 'node:assert/strict'
import test from 'node:test'
import { firstExchange, parseTitle, pickTitleModel, TITLE_MAX_CHARS } from '../src/codex-titles.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { installConfig } from './fake-codex-config.mjs'
import type { FakeConnection } from './fake-upstream.mjs'

const CODEX = { harness: 'codex' }
const LUNA = [
  { id: 'gpt-6-sol', model: 'gpt-6-sol', hidden: false },
  { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', hidden: false },
  {
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
  },
]
const KEY = 'litch.autoTitle'
type Named = { threadId?: string; threadName?: string }
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

interface Options {
  models?: unknown[]
  /** 临时会话的回答 */
  answer?: string
  /** 临时会话跑着的时候用户手动改了名 */
  renameDuring?: string
}

/** 假 codex 补上起名要用的几样：会话带回合、模型清单、临时会话的回合、改名 */
async function setup(options: Options = {}) {
  const env = codexRig()
  const { codex } = env
  const state = installConfig(codex)
  state.user = { mcp_servers: { docs: { command: '/bin/echo' } } }
  let serial = 100
  /** 用户会话的回合（thread/read 带回合时给出） */
  const turns = new Map<string, unknown[]>()
  const validatedStart = codex.handlers['thread/start'] as NonNullable<
    (typeof codex.handlers)[string]
  >
  codex.handlers['thread/start'] = (params, connection) => {
    // 先照上游的约束核对参数，结果不要它的：会话标识换成 codex 那种 UUID
    validatedStart(params, connection)
    codex.threads.pop()
    const thread = codexThread(++serial, 9000 + serial, {
      ephemeral: params.ephemeral === true,
      cwd: params.cwd ?? '/work/codex',
      preview: '',
    })
    codex.threads.push(thread)
    return { thread: { ...thread, turns: [] }, model: params.model ?? 'gpt-6-sol' }
  }
  codex.handlers['thread/read'] = (params) => {
    const thread = codex.threads.find((item) => item.id === params.threadId)
    if (!thread) throw new Error('未知会话')
    return { thread: { ...thread, turns: params.includeTurns ? (turns.get(thread.id) ?? []) : [] } }
  }
  codex.handlers['model/list'] = () => ({ data: options.models ?? LUNA, nextCursor: null })
  const validatedTurn = codex.handlers['turn/start'] as NonNullable<(typeof codex.handlers)[string]>
  codex.handlers['turn/start'] = (params, connection) => {
    const result = validatedTurn(params, connection) as { turn: { id: string } }
    const thread = codex.threads.find((item) => item.id === params.threadId)
    if (thread?.ephemeral) {
      const user = codex.threads.find((item) => !item.ephemeral && turns.has(item.id))
      if (options.renameDuring && user) user.name = options.renameDuring
      const turnId = result.turn.id
      // 临时会话只订阅在开它的那条连接上：回答和结束只发给它
      setTimeout(() => {
        const send = (method: string, more: Record<string, unknown>) =>
          (connection as FakeConnection).send({ method, params: { threadId: thread.id, ...more } })
        send('item/completed', {
          turnId,
          item: {
            type: 'agentMessage',
            id: 'a1',
            text: options.answer ?? '{"title": "“CSV 转 JSON 脚本”。"}',
          },
        })
        send('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } })
      }, 5)
    }
    return result
  }
  codex.handlers['thread/name/set'] = (params) => {
    const thread = codex.threads.find((item) => item.id === params.threadId)
    if (thread) thread.name = params.name
    setTimeout(
      () =>
        codex.notify('thread/name/updated', { threadId: params.threadId, threadName: params.name }),
      1,
    )
    return {}
  }

  /** 客户端新建会话、发一句话，codex 说第一回合结束了 */
  async function firstTurn(client: ReturnType<typeof env.connect>, status = 'completed') {
    const started = await client.call('thread/start', { ...CODEX, cwd: '/work/codex' })
    const threadId = started.thread.id as string
    turns.set(threadId, [
      {
        id: 'u1',
        items: [
          { type: 'userMessage', id: 'm1', content: text('帮我写个 CSV 转 JSON 的脚本') },
          { type: 'agentMessage', id: 'm2', text: '好的，下面是脚本。' },
        ],
      },
    ])
    await client.call('turn/start', { threadId, input: text('帮我写个 CSV 转 JSON 的脚本') })
    codex.notify('turn/completed', { threadId, turn: { id: `turn-of-${threadId}`, status } })
    return threadId
  }

  /** 设备进程开过的临时会话的 thread/start 参数 */
  const temporaries = () => sentTo(codex, 'thread/start').filter((params) => params.ephemeral)

  return { env, codex, state, firstTurn, temporaries }
}

test('第一回合正常结束：设备进程开只读、不带工具的临时会话，用最新的 luna 起名，退订，名字写回去', async () => {
  const { env, codex, firstTurn, temporaries } = await setup()
  const client = env.connect()
  try {
    await client.initialize(['harness', 'harnessConfig'])
    const threadId = await firstTurn(client)
    const named = await client.waitFor(
      (frame) =>
        frame.method === 'thread/name/updated' && (frame.params as Named).threadId === threadId,
    )
    assert.equal((named.params as Named).threadName, 'CSV 转 JSON 脚本')
    const [temporary] = temporaries()
    assert.equal(temporary.model, 'gpt-6-luna')
    assert.equal(temporary.sandbox, 'read-only')
    assert.equal(temporary.approvalPolicy, 'never')
    assert.equal(temporary.threadSource, 'thread_title')
    assert.deepEqual(temporary.dynamicTools, [])
    assert.deepEqual(temporary.config.mcp_servers, { docs: { enabled: false } })
    assert.equal(temporary.config['features.shell_tool'], false)
    const turn = sentTo(codex, 'turn/start').find((params) => params.threadId !== threadId)
    assert.equal(turn.effort, 'low')
    assert.deepEqual(turn.outputSchema.required, ['title'])
    assert.match(turn.input[0].text, /帮我写个 CSV 转 JSON 的脚本/)
    assert.match(turn.input[0].text, /好的，下面是脚本/)
    await env.device.titles.settled()
    assert.equal(sentTo(codex, 'thread/unsubscribe').length, 1)
    // 只试一次：同一个会话再结束一个回合不再起名
    codex.notify('turn/completed', { threadId, turn: { id: 'turn-2', status: 'completed' } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await env.device.titles.settled()
    assert.equal(temporaries().length, 1)
    assert.equal(sentTo(codex, 'thread/name/set').length, 1)
  } finally {
    client.close()
    await env.close()
  }
})

test('不起名：第一回合没正常结束、模型清单里没有 luna', async () => {
  const interrupted = await setup()
  let client = interrupted.env.connect()
  try {
    await client.initialize(['harness', 'harnessConfig'])
    const threadId = await interrupted.firstTurn(client, 'interrupted')
    // 第一回合被打断：这个会话不再试，后面的回合正常结束了也不起
    interrupted.codex.notify('turn/completed', {
      threadId,
      turn: { id: 'turn-2', status: 'completed' },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await interrupted.env.device.titles.settled()
    assert.equal(interrupted.temporaries().length, 0)
  } finally {
    client.close()
    await interrupted.env.close()
  }

  const plain = await setup({ models: [{ id: 'gpt-6-sol', model: 'gpt-6-sol' }] })
  client = plain.env.connect()
  try {
    await client.initialize(['harness', 'harnessConfig'])
    const threadId = await plain.firstTurn(client)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await plain.env.device.titles.settled()
    assert.equal(plain.temporaries().length, 0, '没有 luna 不退回别的模型')
    assert.equal(sentTo(plain.codex, 'thread/name/set').length, 0)
    assert.ok(plain.env.logs.some((line) => line.includes('没有 luna') && line.includes(threadId)))
  } finally {
    client.close()
    await plain.env.close()
  }
})

test('起名途中用户手动改了名：不覆盖', async () => {
  const { env, codex, firstTurn, temporaries } = await setup({ renameDuring: '我自己起的' })
  const client = env.connect()
  try {
    await client.initialize(['harness', 'harnessConfig'])
    const threadId = await firstTurn(client)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await env.device.titles.settled()
    assert.equal(temporaries().length, 1)
    assert.equal(sentTo(codex, 'thread/name/set').length, 0)
    assert.equal(codex.threads.find((thread) => thread.id === threadId)?.name, '我自己起的')
  } finally {
    client.close()
    await env.close()
  }
})

test('开关：详情设置里的“自动起名”默认开，关掉存在设备进程里、不写 config.toml，之后新建的会话不起名', async () => {
  const { env, codex, state, firstTurn, temporaries } = await setup()
  const client = env.connect()
  try {
    await client.initialize(['harness', 'harnessConfig'])
    const read = await client.call('litch/harness/config/read', CODEX)
    const spec = read.settings.find((item: { key: string }) => item.key === KEY)
    assert.equal(spec.type, 'boolean')
    assert.equal(spec.default, true)
    assert.equal(spec.group, 'behavior')
    assert.ok(spec.title['zh-CN'] && spec.title.en)
    assert.equal(KEY in read.values, false)
    await client.call('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: KEY, value: false }],
      expectedVersion: read.version,
    })
    assert.equal(state.writes.length, 0, '开关不写进 config.toml')
    const off = await client.call('litch/harness/config/read', CODEX)
    assert.equal(off.values[KEY], false)
    await firstTurn(client)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await env.device.titles.settled()
    assert.equal(temporaries().length, 0)
    // 清掉回到默认（开着）
    await client.call('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: KEY, value: null }],
      expectedVersion: off.version,
    })
    const back = await client.call('litch/harness/config/read', CODEX)
    assert.equal(KEY in back.values, false)
    const threadId = await firstTurn(client)
    await client.waitFor(
      (frame) =>
        frame.method === 'thread/name/updated' && (frame.params as Named).threadId === threadId,
    )
    assert.equal(sentTo(codex, 'thread/name/set').length, 1)
  } finally {
    client.close()
    await env.close()
  }
})

test('挑模型、取标题、取第一句话', () => {
  assert.deepEqual(pickTitleModel(LUNA), { model: 'gpt-6-luna', low: true })
  assert.deepEqual(
    pickTitleModel([{ model: 'gpt-5.6-luna', supportedReasoningEfforts: ['medium'] }]),
    { model: 'gpt-5.6-luna', low: false },
  )
  assert.equal(pickTitleModel([{ model: 'gpt-6-sol' }]), null)
  assert.equal(parseTitle('{"title": "  修 复\\n登录 跳转。 "}'), '修 复 登录 跳转')
  assert.equal(parseTitle('不是 JSON'), null)
  assert.equal(parseTitle('{"title": "   "}'), null)
  assert.equal(
    Array.from(parseTitle(`{"title": "${'长'.repeat(80)}"}`) ?? '').length,
    TITLE_MAX_CHARS,
  )
  assert.deepEqual(firstExchange({ preview: '只有图片时的预览', turns: [] }), {
    request: '只有图片时的预览',
    answer: null,
  })
  assert.equal(firstExchange({ preview: '', turns: [] }), null)
})
