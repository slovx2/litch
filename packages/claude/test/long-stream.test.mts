import assert from 'node:assert/strict'
import { copyFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeHandlers } from '../src/types.mjs'

// 很长的流式回答：处理一条增量的开销不能随回答已有的长度涨。涨的话整个回答就是平方级的——
// 以前每条正文增量都把整个回合读出来、解析、序列化、写回去（还为了问一句“回合还在跑吗”再读一遍），
// 一万条增量、四十万字的回答光入口进程就是一分钟的 CPU。
// 这种事容易悄悄回来，而且看钟的用例在慢机器上不稳，所以这里数两样和机器快慢无关的量
// （和 Pi 入口的 packages/pi/test/long-stream.test.mts 是同一个量法）：
//   回合期间库被改了几行（SQLite 自己记的数）。写一次回合就是把整个回合写一遍，次数不能跟着增量的条数走；
//   整个进程里 JSON.stringify 一共产出了多少个字。谁每条增量都把累计的内容序列化一遍
//   （落库、通知里带全文、记日志），这个数就是平方级的。
// 同时守着“增量只记一笔、要读写回合时才写”不许改变的几件事：客户端收到的增量逐条照旧；
// 流到一半时读会话、中途连上来恢复会话，拿到的是已经发出去的全部内容；回合结束后落库的是全文；
// 回合被打断、服务正常停下时，已经发出去的字都在库里。

interface Recorder extends RpcPeer {
  messages: any[]
  deltas(method: string): string[]
}

/** 一条连接。和真的传输一样，发出去的每条消息都序列化一遍（数进上面说的第二个量里） */
function recorder(id: string): Recorder {
  const messages: any[] = []
  return {
    id,
    messages,
    close() {},
    send(message) {
      messages.push(JSON.parse(JSON.stringify(message)))
    },
    deltas: (method) => messages.filter((m) => m.method === method).map((m) => m.params.delta),
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(what: string, reached: () => boolean): Promise<void> {
  for (let waited = 0; waited < 90_000; waited += 5) {
    if (reached()) return
    await pause(5)
  }
  throw new Error(`等待超时：${what}`)
}

interface Scene {
  server: CodexClaudeAppServer
  store: SessionStore
  /** 状态目录，库就在里面 */
  home: string
  cwd: string
  first: Recorder
  /** 回合进行到一半才连上来的那条连接 */
  late: Recorder
  ok(peer: Recorder, method: string, params: unknown): Promise<any>
  /** 库到现在一共被改了多少行（服务用的那条连接自己记的数） */
  changes(): number
  /** 到现在一共往库里写了多少个字：插入、改写的语句带进去的字符串参数加起来 */
  written(): number
}

/** 进程内的服务加真的库；运行时由用例给。收场时服务还没停的话替它停掉 */
async function scene(runtime: ClaudeRuntime, run: (scene: Scene) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'cc-long-'))
  const previous = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = home
  const store = new SessionStore(join(home, 'state.sqlite'))
  // 库的连接是存储自己的，计数只能问这一条连接；写了多少字在它备语句的地方数
  const db = (store as unknown as { db: { prepare(sql: string): any } }).db
  let writtenChars = 0
  const prepare = db.prepare.bind(db)
  db.prepare = (sql: string) => {
    const statement = prepare(sql)
    if (!/^\s*(INSERT|UPDATE)/i.test(sql)) return statement
    const run = statement.run.bind(statement)
    statement.run = (...values: unknown[]) => {
      for (const value of values) if (typeof value === 'string') writtenChars += value.length
      return run(...values)
    }
    return statement
  }
  const server = new CodexClaudeAppServer(store, runtime)
  let sequence = 0
  const ok = async (peer: Recorder, method: string, params: unknown): Promise<any> => {
    const id = `${peer.id}:${++sequence}`
    await server.handle(peer, { jsonrpc: '2.0', id, method, params })
    const reply = peer.messages.find((m) => m.id === id && !m.method)
    assert.equal(reply?.error, undefined, `${method}: ${JSON.stringify(reply?.error)}`)
    return reply.result
  }
  try {
    const first = recorder('first')
    const late = recorder('late')
    for (const peer of [first, late])
      await ok(peer, 'initialize', {
        clientInfo: { name: peer.id, title: null, version: '1.0.0' },
        capabilities: null,
      })
    // 握手之后的账号与 MCP 状态通知是异步发的，等它们落定
    await pause(20)
    const changes = () => Number(db.prepare('SELECT total_changes() AS n').get().n)
    const written = () => writtenChars
    await run({ server, store, home, cwd: home, first, late, ok, changes, written })
  } finally {
    await server.stop()
    if (previous === undefined) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** 一个回合里说了什么：状态、思考、正文 */
const said = (turn: any) => ({
  status: turn.status,
  thinking: turn.items.find((item: any) => item.type === 'reasoning')?.summary,
  text: turn.items.find((item: any) => item.type === 'agentMessage')?.text,
})

// ---------- Claude Code 的 SDK 交出来的消息（照 CLI 开着 includePartialMessages 时的样子） ----------
const sdkStream = (event: Record<string, unknown>) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event,
})
const sdkDelta = (type: 'text' | 'thinking', text: string, index: number) =>
  sdkStream({ type: 'content_block_delta', index, delta: { type: `${type}_delta`, [type]: text } })
/** 一个内容块流完之后，CLI 把整块再交一遍 */
const sdkAssistant = (uuid: string, block: Record<string, unknown>, id = 'msg_long') => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { id, content: [block] },
})

const THOUGHTS = 4000
const PIECES = 6000
/** 正文流到第几条时停住，等用例看完流到一半的样子再放行 */
const HOLD_AT = 2500

test('STREAM-CC-001：一万条增量的回答，写库的次数和序列化的量不随条数涨', {
  timeout: 180_000,
}, async (t) => {
  const thoughts = Array.from(
    { length: THOUGHTS },
    (_, index) => `想到第 ${index} 步：先看已有的再往下推。`,
  )
  const pieces = Array.from(
    { length: PIECES },
    (_, index) => `第 ${index} 段，const n${index} = ${index}\n`,
  )
  const whole = pieces.join('')
  // 要交的消息都先备好：运行时和被测的服务在同一个进程里，交的时候不能再往“序列化了多少”里添数
  const messages = [
    sdkStream({ type: 'message_start', message: { id: 'msg_long', usage: {} } }),
    sdkStream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    ...thoughts.map((text) => sdkDelta('thinking', text, 0)),
    sdkStream({ type: 'content_block_stop', index: 0 }),
    sdkAssistant('uuid-thinking', { type: 'thinking', thinking: thoughts.join('') }),
    sdkStream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    ...pieces.map((text) => sdkDelta('text', text, 1)),
    sdkStream({ type: 'content_block_stop', index: 1 }),
    sdkAssistant('uuid-text', { type: 'text', text: whole }),
    sdkStream({ type: 'message_stop' }),
    { type: 'result', subtype: 'success', result: whole, session_id: 'session-long' },
  ]
  /** 正文第 HOLD_AT 条在 messages 里的位置：前面是开头两条、全部思考、思考的收尾两条和正文块的开头 */
  const holdAt = 2 + THOUGHTS + 3 + HOLD_AT
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // 真的原生运行时，只把 SDK 换成照着念的：适配器自己处理一条流式消息的全程都在里面，不起 CLI、不连模型
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      for (let index = 0; index < messages.length; index++) {
        if (index === holdAt) await held
        yield messages[index]
        // 隔一阵让出一次，别让整个回答在一口气里处理完
        if (index % 50 === 49) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    },
  })
  const stringify = JSON.stringify
  let stringified = 0
  await scene(runtime, async ({ first, late, ok, changes, cwd }) => {
    try {
      const threadId = (await ok(first, 'thread/start', { cwd })).thread.id
      // 从这里数到回合结束
      JSON.stringify = ((...args: Parameters<typeof stringify>) => {
        const text = stringify(...args)
        if (typeof text === 'string') stringified += text.length
        return text
      }) as typeof stringify
      const changesBefore = changes()
      const input = [{ type: 'text', text: '说长一点' }]
      const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id

      // 流到一半：思考说完了，正文停在第 HOLD_AT 条。回合这时就结束了的话是运行时没起来
      // （它起会话时要认得出 CHA_CLAUDE_CLI 指的那个 CLI，虽然这里并不执行它），把原因说出来，不干等
      const over = () => first.messages.find((m) => m.method === 'turn/completed')?.params.turn
      await until(
        '正文流到一半',
        () => first.deltas('item/agentMessage/delta').length === HOLD_AT || over() !== undefined,
      )
      assert.equal(over(), undefined, `回合中途结束了：${JSON.stringify(over()?.error)}`)
      const half = pieces.slice(0, HOLD_AT).join('')
      const midway = { status: 'inProgress', thinking: [thoughts.join('')], text: half }
      const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
      assert.deepEqual(said(read.thread.turns.at(-1)), midway, '流到一半时读会话')
      const listed = await ok(first, 'thread/turns/list', { threadId, itemsView: 'full' })
      assert.deepEqual(said(listed.data.at(-1)), midway, '流到一半时分页读回合')
      // 另一条连接这时才连上来恢复这个会话：它拿到的那一份，加上之后收到的增量，要正好是全文
      const resumed = await ok(late, 'thread/resume', { threadId })
      assert.deepEqual(said(resumed.thread.turns.at(-1)), midway, '流到一半时恢复会话')
      assert.deepEqual(late.deltas('item/agentMessage/delta'), [])

      release()
      await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
      JSON.stringify = stringify
      const written = changes() - changesBefore

      // 客户端收到的：增量逐条照旧，条目开始时不带字，完成时带全文
      assert.deepEqual(first.deltas('item/reasoning/summaryTextDelta'), thoughts)
      assert.deepEqual(first.deltas('item/agentMessage/delta'), pieces)
      assert.equal(half + late.deltas('item/agentMessage/delta').join(''), whole)
      const methods = first.messages.map((m) => m.method)
      const allStarted = first.messages.filter((m) => m.method === 'item/started')
      // 用户消息照上游作为条目先发出来；下面看的是回答的条目
      assert.deepEqual(
        allStarted.map((m) => m.params.item.type),
        ['userMessage', 'reasoning', 'agentMessage'],
      )
      const started = allStarted.slice(1)
      assert.deepEqual(
        started.map((m) => m.params.item.text ?? m.params.item.summary),
        [[], ''],
      )
      // 思考的摘要“多了一段”只在头一条思考增量之前报一次
      const parts = methods.filter((method) => method === 'item/reasoning/summaryPartAdded')
      assert.equal(parts.length, 1)
      assert.equal(
        methods.indexOf('item/reasoning/summaryPartAdded') + 1,
        methods.indexOf('item/reasoning/summaryTextDelta'),
      )
      // 先后：思考开始、思考的增量、思考完成，然后才是正文开始、正文的增量、正文完成
      const order = [
        methods.indexOf('item/reasoning/summaryTextDelta'),
        methods.lastIndexOf('item/reasoning/summaryTextDelta'),
        first.messages.indexOf(started[1]),
        methods.indexOf('item/agentMessage/delta'),
        methods.lastIndexOf('item/agentMessage/delta'),
        methods.indexOf('turn/completed'),
      ]
      assert.deepEqual(
        order,
        [...order].sort((a, b) => a - b),
      )
      const ended = { status: 'completed', thinking: [thoughts.join('')], text: whole }
      const finished = first.messages
        .filter((m) => m.method === 'item/completed')
        .map((m) => m.params.item)
      assert.deepEqual(said({ status: 'completed', items: finished }), ended, '条目完成时带全文')
      const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
      assert.equal(completed.id, turnId)
      assert.equal(completed.status, 'completed')
      // 回合结束后落库的
      const stored = (await ok(first, 'thread/read', { threadId, includeTurns: true })).thread
      assert.equal(stored.turns.at(-1).id, turnId)
      assert.deepEqual(said(stored.turns.at(-1)), ended, '回合结束后读会话')

      // 两样量。整个回合（思考加正文）有多少个字、一共多少条增量：
      const size = thoughts.join('').length + whole.length
      const deltas = THOUGHTS + PIECES
      // 序列化：每条增量是一条通知加一行调试日志，各两三百个字，两条连接各一份；带全文的（条目完成、
      // 中途的三次读、落库）各是回合的几倍。每条增量都把累计的内容序列化一遍的话，是条数乘全文的一半
      const linear = deltas * 2 * 700 + size * 30
      t.diagnostic(
        `${deltas} 条增量、全文 ${size} 个字：库被改了 ${written} 行，序列化了 ${stringified} 个字（上限 ${linear}）`,
      )
      // 库：回合的开始和结束、条目的开始和完成、会话的状态、用量、中途的读，加起来是和条数无关的二十几行
      assert.ok(written < 60, `回合期间库被改了 ${written} 行，条数是 ${deltas}`)
      assert.ok(linear < (deltas * size) / 20, '这个上限得比平方级的量小得多才有意义')
      assert.ok(stringified < linear, `回合期间序列化了 ${stringified} 个字，上限 ${linear}`)
    } finally {
      JSON.stringify = stringify
      release()
    }
  })
})

// ---------- 照剧本走的运行时：命令的输出、打断、停服务 ----------
interface Gate {
  /** 剧本走到这里停住，等放行 */
  wait: Promise<void>
  open(): void
}
function gate(): Gate {
  let open = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 只照剧本发事件的运行时。被打断、被停下时把剧本里等着的地方都放开，让它走完（之后的事件服务不再认） */
function scripted(gates: Gate[], script: (handlers: RuntimeHandlers) => Promise<void>) {
  const release = async () => {
    for (const each of gates) each.open()
  }
  const runtime: ClaudeRuntime = {
    runTurn: (_context, handlers) => script(handlers),
    steer: async () => {},
    interrupt: release,
    stop: release,
  }
  return runtime
}

test('STREAM-CC-002：命令的输出流到一半时读会话读得到，接着被打断也不丢', {
  timeout: 120_000,
}, async () => {
  const LINES = 3000
  const lines = Array.from({ length: LINES }, (_, index) => `第 ${index} 行输出\n`)
  /** 先停在这里让用例读一次，再停在后面让用例直接打断 */
  const [readAt, stopAt] = [1000, 2000]
  const [reading, stopping] = [gate(), gate()]
  const runtime = scripted([reading, stopping], async (handlers) => {
    const toolUseId = 'toolu_long_output'
    const input = { command: 'seq 1 3000' }
    await handlers.onEvent({ type: 'tool_use', toolUseId, toolName: 'Bash', input })
    for (let index = 0; index < LINES; index++) {
      if (index === readAt) await reading.wait
      if (index === stopAt) await stopping.wait
      await handlers.onEvent({ type: 'tool_output_delta', toolUseId, delta: lines[index] ?? '' })
      if (index % 50 === 49) await breathe()
    }
    await handlers.onEvent({ type: 'completed', success: true, result: '' })
  })
  await scene(runtime, async ({ first, late, ok, changes, cwd }) => {
    const OUTPUT = 'item/commandExecution/outputDelta'
    const running = (turn: any) => {
      const item = turn.items.find((entry: any) => entry.type === 'commandExecution')
      return { turn: turn.status, output: item?.aggregatedOutput }
    }
    const threadId = (await ok(first, 'thread/start', { cwd })).thread.id
    const changesBefore = changes()
    const input = [{ type: 'text', text: '跑一条输出很长的命令' }]
    const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id

    await until('命令的输出流到第一处', () => first.deltas(OUTPUT).length === readAt)
    const written = changes() - changesBefore
    assert.ok(written < 30, `一千条输出增量期间库被改了 ${written} 行`)
    const firstPart = { turn: 'inProgress', output: lines.slice(0, readAt).join('') }
    const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
    assert.deepEqual(running(read.thread.turns.at(-1)), firstPart, '命令跑到一半时读会话')
    const resumed = await ok(late, 'thread/resume', { threadId })
    assert.deepEqual(running(resumed.thread.turns.at(-1)), firstPart, '命令跑到一半时恢复会话')

    // 再流一千条，这一段谁都没读过，直接打断：已经发出去的输出要在库里
    reading.open()
    await until('命令的输出流到第二处', () => first.deltas(OUTPUT).length === stopAt)
    await ok(first, 'turn/interrupt', { threadId, turnId })
    await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
    assert.deepEqual(first.deltas(OUTPUT), lines.slice(0, stopAt))
    assert.equal(late.deltas(OUTPUT).join(''), lines.slice(readAt, stopAt).join(''))
    const secondPart = { turn: 'interrupted', output: lines.slice(0, stopAt).join('') }
    const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
    assert.equal(completed.status, 'interrupted')
    const stored = await ok(first, 'thread/read', { threadId, includeTurns: true })
    assert.deepEqual(running(stored.thread.turns.at(-1)), secondPart, '打断之后读会话')
  })
})

test('STREAM-CC-003：正文流到一半时服务正常停下，重新打开库，已经发出去的字都在', {
  timeout: 120_000,
}, async () => {
  const PIECES_SENT = 1500
  const pieces = Array.from({ length: PIECES_SENT }, (_, index) => `第 ${index} 段。`)
  const stopping = gate()
  const runtime = scripted([stopping], async (handlers) => {
    for (const piece of pieces) await handlers.onEvent({ type: 'text_delta', delta: piece })
    await stopping.wait
    await handlers.onEvent({ type: 'completed', success: true, result: pieces.join('') })
  })
  await scene(runtime, async ({ server, home, first, ok, cwd }) => {
    const threadId = (await ok(first, 'thread/start', { cwd })).thread.id
    const input = [{ type: 'text', text: '说到一半' }]
    const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id
    await until(
      '正文都发出去了',
      () => first.deltas('item/agentMessage/delta').length === PIECES_SENT,
    )
    // 这些字谁都没读过，还只是记着的：停服务（收到结束信号、连接都断开后空闲退出，走的都是这里）
    await server.stop()
    const reopened = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turn = reopened.listTurns(threadId).at(-1)
      assert.equal(turn?.id, turnId)
      assert.deepEqual(said(turn), {
        status: 'interrupted',
        thinking: undefined,
        text: pieces.join(''),
      })
    } finally {
      reopened.close()
    }
  })
})

// ---------- 条目的增减：一个回合里很多次工具调用，每次结果都很大 ----------
// 以前每次工具调用的开始和结束（还有它前后的思考、正文条目的开始和完成）都把整个回合读出来、解析、
// 序列化、整行写回去：一个回合三百次调用、每次结果两万字，光入口就是几十秒的 CPU，越到后面每次越贵。
// 现在一个条目的增减只记这一个条目（turn_item_log 里一行），回合被读、被整行写、结束时才合进那一行。
// 量法同上：写进库的字数、序列化的字数，都不能随回合里已有的内容涨。

const CALLS = 200
const OUTPUT = 4000
/** 停在第几次调用之前，让用例看看回合进行到一半的样子 */
const HOLD_CALL = 120

/** 一次工具调用的结果：开头标上是第几次，别的调用的结果放错了地方看得出来 */
const toolOutput = (index: number) => `${index}:`.padEnd(OUTPUT, '输出的一行。\n')
/** 模型的一条消息：先想一句、说一句，再调一次 Bash；CLI 带回来的是这次调用的结果 */
function toolCall(index: number): Record<string, unknown>[] {
  const id = `msg_tool_${index}`
  const toolUseId = `toolu_long_${index}`
  const thought = `想想第 ${index} 次该看什么。`
  const said = `看一下第 ${index} 个文件。`
  const output = toolOutput(index)
  return [
    sdkStream({ type: 'message_start', message: { id, usage: {} } }),
    sdkStream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    sdkDelta('thinking', thought, 0),
    sdkStream({ type: 'content_block_stop', index: 0 }),
    sdkAssistant(`uuid-thinking-${index}`, { type: 'thinking', thinking: thought }, id),
    sdkStream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    sdkDelta('text', said, 1),
    sdkStream({ type: 'content_block_stop', index: 1 }),
    sdkAssistant(`uuid-text-${index}`, { type: 'text', text: said }, id),
    sdkAssistant(
      `uuid-tool-${index}`,
      { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `cat ${index}.txt` } },
      id,
    ),
    sdkStream({ type: 'message_stop' }),
    {
      type: 'user',
      uuid: `uuid-result-${index}`,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: false },
        ],
      },
      tool_use_result: { stdout: output, stderr: '', interrupted: false, isImage: false },
    },
  ]
}

/** 回合里除了用户的话以外的条目 */
const produced = (turn: any) => turn.items.filter((item: any) => item.type !== 'userMessage')
/** 一条连接到现在收到的、已经完成的条目（照完成的先后） */
const completedItems = (peer: Recorder) =>
  peer.messages.filter((m) => m.method === 'item/completed').map((m) => m.params.item)

test('STREAM-CC-004：一个回合里两百次工具调用、每次结果几千字，写库和序列化的量不随调用次数涨', {
  timeout: 180_000,
}, async (t) => {
  const messages = [
    ...Array.from({ length: CALLS }, (_, index) => toolCall(index)).flat(),
    sdkStream({ type: 'message_start', message: { id: 'msg_done', usage: {} } }),
    sdkAssistant('uuid-done', { type: 'text', text: '看完了。' }, 'msg_done'),
    sdkStream({ type: 'message_stop' }),
    { type: 'result', subtype: 'success', result: '看完了。', session_id: 'session-tools' },
  ]
  /** 第 HOLD_CALL 次调用的头一条消息在 messages 里的位置 */
  const holdAt = toolCall(0).length * HOLD_CALL
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // 和 STREAM-CC-001 一样：真的原生运行时，只把 SDK 换成照着念的
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      for (let index = 0; index < messages.length; index++) {
        if (index === holdAt) await held
        yield messages[index]
        if (index % 50 === 49) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    },
  })
  const stringify = JSON.stringify
  let stringified = 0
  await scene(runtime, async ({ first, late, ok, changes, written, home, cwd }) => {
    try {
      const threadId = (await ok(first, 'thread/start', { cwd })).thread.id
      JSON.stringify = ((...args: Parameters<typeof stringify>) => {
        const text = stringify(...args)
        if (typeof text === 'string') stringified += text.length
        return text
      }) as typeof stringify
      const [changesBefore, writtenBefore] = [changes(), written()]
      const input = [{ type: 'text', text: '把这些文件挨个看一遍' }]
      const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id
      const over = () => first.messages.find((m) => m.method === 'turn/completed')?.params.turn
      const commands = (peer: Recorder) =>
        completedItems(peer).filter((item: any) => item.type === 'commandExecution')
      await until(
        '回合进行到一半',
        () => commands(first).length === HOLD_CALL || over() !== undefined,
      )
      assert.equal(over(), undefined, `回合中途结束了：${JSON.stringify(over()?.error)}`)

      // 进行到一半：读会话、分页读回合、另一条连接恢复会话，拿到的条目就是已经完成、发出去的那些
      const sent = completedItems(first).filter((item: any) => item.type !== 'userMessage')
      assert.equal(sent.length, HOLD_CALL * 3)
      assert.deepEqual(
        commands(first).map((item: any) => [item.status, item.aggregatedOutput]),
        Array.from({ length: HOLD_CALL }, (_, index) => ['completed', toolOutput(index)]),
      )
      const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
      assert.deepEqual(produced(read.thread.turns.at(-1)), sent, '进行到一半时读会话')
      const listed = await ok(first, 'thread/turns/list', { threadId, itemsView: 'full' })
      assert.deepEqual(produced(listed.data.at(-1)), sent, '进行到一半时分页读回合')
      const resumed = await ok(late, 'thread/resume', { threadId })
      assert.deepEqual(produced(resumed.thread.turns.at(-1)), sent, '进行到一半时恢复会话')
      // 进程这时被强杀：库里有的就是这些（把库照原样拷一份，当成强杀之后重新打开）
      const crashed = join(home, 'crashed.sqlite')
      copyFileSync(join(home, 'state.sqlite'), crashed)

      release()
      await until('回合结束', () => over() !== undefined)
      JSON.stringify = stringify
      const [rows, chars] = [changes() - changesBefore, written() - writtenBefore]

      assert.equal(over().id, turnId)
      assert.equal(over().status, 'completed')
      const all = completedItems(first).filter((item: any) => item.type !== 'userMessage')
      assert.equal(all.length, CALLS * 3 + 1)
      assert.deepEqual(
        commands(first).map((item: any) => item.aggregatedOutput),
        Array.from({ length: CALLS }, (_, index) => toolOutput(index)),
      )
      const stored = (await ok(first, 'thread/read', { threadId, includeTurns: true })).thread
      assert.deepEqual(produced(stored.turns.at(-1)), all, '回合结束后读会话')
      // 后连上来的那条：恢复时拿到的加上之后收到的完成的条目，正好是全部
      assert.deepEqual([...sent, ...completedItems(late)], all)

      // 量（这两样都从回合开始数到回合结束，中途的三次读和回合结束时的合并都算在里面）。
      // 回合里有多少字：每次调用的结果是大头
      const size = CALLS * OUTPUT
      // 序列化：每次调用的结果在条目改动里记一笔、发通知（输出的增量、条目完成）各一遍、两条连接各一份，
      // 加上带全文的几次（中途的三次读、强杀的那份、合并、结束后的读）各是回合的一两倍。
      // 每次调用都把整个回合序列化一遍的话，是调用次数乘回合的一半再乘好几倍
      const linear = size * 30
      // 写库：每次调用的结果记一笔，加上回合中途被读、结束时合进那一行各写一整遍
      const linearWritten = size * 8
      t.diagnostic(
        `${CALLS} 次调用、结果共 ${size} 个字：库被改了 ${rows} 行，写进库 ${chars} 个字（上限 ${linearWritten}），序列化了 ${stringified} 个字（上限 ${linear}）`,
      )
      assert.ok(linear < (CALLS * size) / 4, '这个上限得比平方级的量小得多才有意义')
      assert.ok(chars < linearWritten, `回合期间往库里写了 ${chars} 个字，上限 ${linearWritten}`)
      assert.ok(stringified < linear, `回合期间序列化了 ${stringified} 个字，上限 ${linear}`)
      // 改了几行：每次调用是几个条目的开始和完成，和以前一样是按条目数算的
      // （记下的一笔是一行，合进回合时删掉它又是一行）
      assert.ok(rows < CALLS * 25, `回合期间库被改了 ${rows} 行`)

      // 强杀之后重新打开：已经完成的条目一个不少，恢复时回合标成被打断
      const reopened = new SessionStore(crashed)
      try {
        assert.deepEqual(produced(reopened.listTurns(threadId).at(-1)), sent, '强杀之后重新打开')
        reopened.recoverStaleInProgressTurns()
        const recovered = reopened.listTurns(threadId).at(-1)
        assert.equal(recovered?.status, 'interrupted')
        assert.deepEqual(produced(recovered), sent)
      } finally {
        reopened.close()
      }
    } finally {
      JSON.stringify = stringify
      release()
    }
  })
})

test('STREAM-CC-005：条目的改动还没合进回合时被打断、出错、服务停下，库里的条目都是全的', {
  timeout: 120_000,
}, async (t) => {
  const DONE = 30
  const expected = Array.from({ length: DONE }, (_, index) => ['completed', toolOutput(index)])
  for (const ending of ['interrupt', 'error', 'stop'] as const) {
    await t.test(ending, async () => {
      const stopping = gate()
      const runtime = scripted([stopping], async (handlers) => {
        for (let index = 0; index < DONE; index++) {
          const toolUseId = `toolu_done_${index}`
          const input = { command: `cat ${index}.txt` }
          await handlers.onEvent({ type: 'tool_use', toolUseId, toolName: 'Bash', input })
          const content = toolOutput(index)
          await handlers.onEvent({ type: 'tool_result', toolUseId, content, isError: false })
        }
        // 最后这一次调用开始了、没有结果，停在这里
        const input = { command: 'sleep 100' }
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId: 'toolu_open',
          toolName: 'Bash',
          input,
        })
        await stopping.wait
        if (ending === 'error') throw new Error('运行时出错了')
        await handlers.onEvent({ type: 'completed', success: true, result: '' })
      })
      await scene(runtime, async ({ server, home, first, ok, cwd }) => {
        const threadId = (await ok(first, 'thread/start', { cwd })).thread.id
        const input = [{ type: 'text', text: '挨个看' }]
        const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id
        const started = () =>
          first.messages.filter(
            (m) => m.method === 'item/started' && m.params.item.type === 'commandExecution',
          ).length
        await until('前面的调用都完成、最后一次开始了', () => started() === DONE + 1)
        const over = () => first.messages.some((m) => m.method === 'turn/completed')
        let turn: any
        if (ending === 'stop') {
          // 谁都没读过这个回合：条目的改动都还只是一笔一笔记着的
          await server.stop()
          const reopened = new SessionStore(join(home, 'state.sqlite'))
          try {
            turn = reopened.listTurns(threadId).at(-1)
          } finally {
            reopened.close()
          }
        } else {
          if (ending === 'interrupt') await ok(first, 'turn/interrupt', { threadId, turnId })
          else stopping.open()
          await until('回合结束', over)
          turn = (await ok(first, 'thread/read', { threadId, includeTurns: true })).thread.turns.at(
            -1,
          )
        }
        assert.equal(turn.id, turnId)
        assert.equal(turn.status, ending === 'error' ? 'failed' : 'interrupted')
        const commands = produced(turn).filter((item: any) => item.type === 'commandExecution')
        assert.equal(commands.length, DONE + 1)
        assert.deepEqual(
          commands.slice(0, DONE).map((item: any) => [item.status, item.aggregatedOutput]),
          expected,
        )
        assert.equal(commands.at(-1).command, 'sleep 100')
      })
    })
  }
})
