import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'
import { PiStore } from '../src/store.mjs'

// 很长的流式回答：处理一条增量的开销不能随回答已有的长度涨。涨的话整个回答就是平方级的——
// 以前每条增量都把整个回合写一遍库，一万条增量、四十万字的回答光这一项就是十几秒的 CPU。
// 这种事容易悄悄回来，而且看钟的用例在慢机器上不稳，所以这里数两样和机器快慢无关的量：
//   回合期间库被改了几行（SQLite 自己记的数）。写一次回合就是把整个回合写一遍，次数不能跟着增量的条数走；
//   整个进程里 JSON.stringify 一共产出了多少个字。谁每条增量都把累计的内容序列化一遍
//   （落库、通知里带全文、记日志），这个数就是平方级的。
// 同时守着“增量只记一笔、要读的时候才写”不许改变的几件事：客户端收到的增量逐条照旧；
// 流到一半时读会话、中途连上来恢复会话，拿到的是已经发出去的全部内容；回合结束后落库的是全文。
// 条目的增减（工具调用的开始和结束、消息的开始和结束）是同一类事，按条目数算：一个回合里调用成百上千次、
// 每次的结果都很大时，每次调用的开销也不能随回合已有的条目涨（STREAM-PI-005、006）。

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

/** 假模型的一帧。要发的帧都先备好再发：假模型和被测的服务在同一个进程里，发的时候不能再往“序列化了多少”里添数 */
const frame = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'long', object: 'chat.completion.chunk', created: 1, model: 'gate', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`

interface Scene {
  server: PiServer
  root: string
  cwd: string
  first: Recorder
  /** 回合进行到一半才连上来的那条连接 */
  late: Recorder
  ok(peer: Recorder, method: string, params: unknown): Promise<any>
}

/** 真实的 Pi 加回环上的假模型：respond 决定每个模型请求怎么答（body 是请求体） */
async function scene(
  respond: (body: any, res: ServerResponse) => Promise<void>,
  run: (scene: Scene) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-long-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    await respond(JSON.parse(Buffer.concat(chunks).toString()), res)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const model = {
    id: 'gate',
    name: 'Gate',
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const gate = {
    baseUrl: `http://127.0.0.1:${(http.address() as any).port}/v1`,
    api: 'openai-completions',
    apiKey: 'test-only',
    models: [model],
  }
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { gate } }))
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  const server = new PiServer(join(root, 'state'))
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
        capabilities: { experimentalApi: true },
      })
    await run({ server, root, cwd, first, late, ok })
  } finally {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

const THOUGHTS = 4000
const PIECES = 6000
/** 正文流到第几条时假模型停住，等用例看完流到一半的样子再放行 */
const HOLD_AT = 2500

test('STREAM-PI-001：一万条增量的回答，写库的次数和序列化的量不随条数涨', {
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
  const frames = [
    frame({ role: 'assistant', content: '' }),
    ...thoughts.map((text) => frame({ reasoning_content: text })),
    ...pieces.map((text) => frame({ content: text })),
    frame({}, 'stop'),
  ]
  /** 正文第 HOLD_AT 条在 frames 里的位置：前面是开头那一帧和全部思考 */
  const holdFrame = 1 + THOUGHTS + HOLD_AT
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const respond = async (_body: any, res: ServerResponse) => {
    for (let index = 0; index < frames.length; index++) {
      if (index === holdFrame) await held
      res.write(frames[index])
      // 隔一阵让出一次，别把整个回答攒成一包
      if (index % 50 === 49) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const stringify = JSON.stringify
  let stringified = 0
  await scene(respond, async ({ server, cwd, first, late, ok }) => {
    /** 库到现在一共被改了多少行 */
    const changes = () => Number(server.store.db.prepare('SELECT total_changes() AS n').get()?.n)
    try {
      const threadId = (await ok(first, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      // 从这里数到回合结束
      JSON.stringify = ((...args: Parameters<typeof stringify>) => {
        const text = stringify(...args)
        if (typeof text === 'string') stringified += text.length
        return text
      }) as typeof stringify
      const changesBefore = changes()
      const input = [{ type: 'text', text: '说长一点' }]
      const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id

      // 流到一半：思考说完了，正文停在第 HOLD_AT 条
      await until('正文流到一半', () => first.deltas('item/agentMessage/delta').length === HOLD_AT)
      const half = pieces.slice(0, HOLD_AT).join('')
      const said = (turn: any) => ({
        status: turn.status,
        thinking: turn.items.find((item: any) => item.type === 'reasoning')?.summary,
        text: turn.items.find((item: any) => item.type === 'agentMessage')?.text,
      })
      const midway = { status: 'inProgress', thinking: [thoughts.join('')], text: half }
      const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
      assert.deepEqual(said(read.thread.turns.at(-1)), midway, '流到一半时读会话')
      // 另一条连接这时才连上来恢复这个会话：它拿到的那一份，加上之后收到的增量，要正好是全文
      const resumed = await ok(late, 'thread/resume', { threadId })
      assert.deepEqual(said(resumed.thread.turns.at(-1)), midway, '流到一半时恢复会话')
      assert.deepEqual(late.deltas('item/agentMessage/delta'), [])

      release()
      await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
      JSON.stringify = stringify
      const written = changes() - changesBefore

      // 客户端收到的：增量逐条照旧，条目开始时不带字，完成时带全文
      const whole = pieces.join('')
      assert.deepEqual(first.deltas('item/reasoning/summaryTextDelta'), thoughts)
      assert.deepEqual(first.deltas('item/agentMessage/delta'), pieces)
      assert.equal(half + late.deltas('item/agentMessage/delta').join(''), whole)
      const methods = first.messages.map((m) => m.method)
      const started = first.messages.filter((m) => m.method === 'item/started')
      const blank = started.map((m) => m.params.item.text ?? m.params.item.summary)
      assert.deepEqual(
        started.map((m) => m.params.item.type),
        ['userMessage', 'reasoning', 'agentMessage'],
      )
      assert.deepEqual(blank.slice(1), [[], ''])
      // 条目的开始先于它自己的增量，增量认的是这个条目；正文条目的开始在思考的最后一条增量之后。
      // Pi 事件里带的消息会超前（处理思考的最后几条增量时，消息里已经有正文那一块了），回合只认处理到的事件
      assert.ok(
        methods.lastIndexOf('item/reasoning/summaryTextDelta') < first.messages.indexOf(started[2]),
        '正文条目的开始不抢在思考的增量前面',
      )
      for (const [index, method] of [
        [1, 'item/reasoning/summaryTextDelta'],
        [2, 'item/agentMessage/delta'],
      ] as const) {
        const opened = started[index]
        assert.ok(first.messages.indexOf(opened) < methods.indexOf(method), `${method} 的先后`)
        const owners = first.messages.filter((m) => m.method === method).map((m) => m.params.itemId)
        assert.deepEqual([...new Set(owners)], [opened.params.item.id])
      }
      const ended = { status: 'completed', thinking: [thoughts.join('')], text: whole }
      const finished = first.messages
        .filter((m) => m.method === 'item/completed')
        .map((m) => m.params.item)
      assert.deepEqual(said({ status: 'completed', items: finished }), ended, '条目完成时带全文')
      const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
      assert.equal(completed.id, turnId)
      assert.deepEqual(said(completed), ended, '回合结束的通知')
      // 回合结束后落库的
      const stored = (await ok(first, 'thread/read', { threadId, includeTurns: true })).thread
      assert.equal(stored.turns.at(-1).id, turnId)
      assert.deepEqual(said(stored.turns.at(-1)), ended, '回合结束后读会话')

      // 两样量。整个回合（思考加正文）有多少个字、一共多少条增量：
      const size = thoughts.join('').length + whole.length
      const deltas = THOUGHTS + PIECES
      // 序列化：每条增量的通知是一条几百个字的小消息，两条连接各一份；带全文的（条目完成、回合结束、
      // 落库、原生会话）各是回合的几倍。每条增量都把累计的内容序列化一遍的话，是条数乘全文的一半
      const linear = deltas * 2 * 600 + size * 40
      t.diagnostic(
        `${deltas} 条增量、全文 ${size} 个字：库被改了 ${written} 行，序列化了 ${stringified} 个字（上限 ${linear}）`,
      )
      // 库：回合的开始和结束、条目的开始和完成、用量、中途那一次读，加起来是和条数无关的十几行
      assert.ok(written < 60, `回合期间库被改了 ${written} 行，条数是 ${deltas}`)
      assert.ok(linear < (deltas * size) / 20, '这个上限得比平方级的量小得多才有意义')
      assert.ok(stringified < linear, `回合期间序列化了 ${stringified} 个字，上限 ${linear}`)
    } finally {
      JSON.stringify = stringify
      release()
    }
  })
})

test('STREAM-PI-002：命令的输出流到一半时读会话，读得到已经发出去的输出', {
  timeout: 120_000,
}, async () => {
  await scene(
    // 头一次请求让 Pi 跑一条命令，带着命令的结果再来问时回一句话收场
    async (body, res) => {
      const ran = body.messages.at(-1)?.role === 'tool'
      const call = { index: 0, id: 'call_1', type: 'function' }
      // 命令先出前一半，等到放行的文件出现再出后一半
      const command = 'printf 前一半; while [ ! -e go ]; do sleep 0.05; done; printf 后一半'
      const run = { name: 'bash', arguments: JSON.stringify({ command }) }
      res.write(
        ran
          ? frame({ role: 'assistant', content: '跑完了' })
          : frame({ role: 'assistant', tool_calls: [{ ...call, function: run }] }),
      )
      res.write(frame({}, ran ? 'stop' : 'tool_calls'))
    },
    async ({ cwd, first, late, ok }) => {
      const threadId = (await ok(first, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      await ok(first, 'turn/start', { threadId, input: [{ type: 'text', text: '跑一条命令' }] })
      const OUTPUT = 'item/commandExecution/outputDelta'
      await until('命令出了前一半', () => first.deltas(OUTPUT).join('') === '前一半')
      const running = (turn: any) => {
        const item = turn.items.find((entry: any) => entry.type === 'commandExecution')
        return { turn: turn.status, command: item?.status, output: item?.aggregatedOutput }
      }
      const midway = { turn: 'inProgress', command: 'inProgress', output: '前一半' }
      const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
      assert.deepEqual(running(read.thread.turns.at(-1)), midway, '命令跑到一半时读会话')
      const resumed = await ok(late, 'thread/resume', { threadId })
      assert.deepEqual(running(resumed.thread.turns.at(-1)), midway, '命令跑到一半时恢复会话')

      await writeFile(join(cwd, 'go'), '')
      await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
      // 后一半有没有赶上作为增量发出来要看 Pi 的节流，条目完成时一定是全的
      assert.ok('前一半后一半'.startsWith(first.deltas(OUTPUT).join('')))
      assert.ok('后一半'.startsWith(late.deltas(OUTPUT).join('')))
      const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
      assert.deepEqual(running(completed), {
        turn: 'completed',
        command: 'completed',
        output: '前一半后一半',
      })
    },
  )
})

test('STREAM-PI-003：命令的输出过了 Pi 保留的窗口，增量仍然只是新增的一段，中途读到的和之后的增量接得上', {
  timeout: 120_000,
}, async () => {
  // 一批五百行、一共十二批；每出一批就等用例放行（工作目录里出现 go<批次>），所以每批至少有一份快照，
  // 快慢由用例定，不看钟。Pi 只留末尾两千行：从第五批起它给的快照是往后滑的窗口
  const BATCHES = 12
  const numbers = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `${from + index}\n`).join('')
  const command = `i=0; while [ $i -lt ${BATCHES} ]; do seq $((i*500+1)) $((i*500+500)); i=$((i+1)); while [ ! -e go$i ]; do sleep 0.01; done; done`
  await scene(
    async (body, res) => {
      const ran = body.messages.at(-1)?.role === 'tool'
      const call = { index: 0, id: 'call_1', type: 'function' }
      const run = { name: 'bash', arguments: JSON.stringify({ command }) }
      res.write(
        ran
          ? frame({ role: 'assistant', content: '跑完了' })
          : frame({ role: 'assistant', tool_calls: [{ ...call, function: run }] }),
      )
      res.write(frame({}, ran ? 'stop' : 'tool_calls'))
    },
    async ({ cwd, first, late, ok }) => {
      const threadId = (await ok(first, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      await ok(first, 'turn/start', { threadId, input: [{ type: 'text', text: '跑一条命令' }] })
      const OUTPUT = 'item/commandExecution/outputDelta'
      const output = (turn: any) =>
        turn.items.find((entry: any) => entry.type === 'commandExecution')?.aggregatedOutput
      /** 放行到第几批为止，每一批都等它的输出作为增量到了再放下一批 */
      const release = async (from: number, to: number) => {
        for (let batch = from; batch <= to; batch++) {
          const last = `\n${batch * 500}`
          await until(`第 ${batch} 批的输出`, () =>
            first.deltas(OUTPUT).join('').trimEnd().endsWith(last),
          )
          await writeFile(join(cwd, `go${batch}`), '')
        }
      }
      await release(1, 7)
      await until('第 8 批的输出', () => first.deltas(OUTPUT).join('').endsWith('\n4000'))
      // 流到一半：读会话、另一条连接恢复会话，拿到的是 Pi 这一刻的窗口（第 2001 到 4000 行）
      const window = numbers(2001, 4000).slice(0, -1)
      const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
      assert.equal(output(read.thread.turns.at(-1)), window, '命令跑到一半时读会话')
      const resumed = await ok(late, 'thread/resume', { threadId })
      assert.equal(output(resumed.thread.turns.at(-1)), window, '命令跑到一半时恢复会话')

      await release(8, BATCHES)
      await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
      // 一直看着的那条连接：增量接起来是命令的全部输出，不多不少（Pi 截过的快照不带末尾的换行）；没有空的增量。
      // 以前窗口滑起来之后每条增量都是整个窗口，接起来是一遍遍重复的输出
      const whole = numbers(1, BATCHES * 500).slice(0, -1)
      assert.equal(first.deltas(OUTPUT).join(''), whole)
      assert.ok(first.deltas(OUTPUT).every((delta) => delta.length > 0))
      // 中途连上来的：恢复时拿到的窗口加上之后收到的增量，正好接到末尾
      assert.equal(window + late.deltas(OUTPUT).join(''), numbers(2001, 6000).slice(0, -1))
      // 条目完成时是 Pi 给的最后一个窗口加一句说明，比一路接起来的短，客户端以它为准
      const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
      const final: string = output(completed)
      assert.ok(final.startsWith(numbers(4001, 6000).slice(0, -1)), final.slice(0, 80))
      assert.ok(final.length < whole.length / 2)
      // 输出被截过，Pi 把全文留在临时目录的一个文件里，路径在那句说明的末尾
      const kept = /Full output: (.+pi-bash-[0-9a-f]+\.log)\]$/.exec(final)?.[1]
      if (kept?.startsWith(tmpdir())) await rm(kept, { force: true })
    },
  )
})

test('STREAM-PI-004：处理事件的这一头比模型流慢（有扩展在等），流到一半读到的仍然正好是已经发出去的', {
  timeout: 120_000,
}, async () => {
  const thoughts = Array.from({ length: 200 }, (_, index) => `想到第 ${index} 步。`)
  const pieces = Array.from({ length: 500 }, (_, index) => `第 ${index} 段，`)
  const frames = [
    frame({ role: 'assistant', content: '' }),
    ...thoughts.map((text) => frame({ reasoning_content: text })),
    ...pieces.map((text) => frame({ content: text })),
    frame({}, 'stop'),
  ]
  const respond = async (_body: any, res: ServerResponse) => {
    for (let index = 0; index < frames.length; index++) {
      res.write(frames[index])
      if (index % 50 === 49) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  await scene(respond, async ({ root, cwd, first, late, ok }) => {
    // 一个处理 message_update 时等一毫秒的扩展：模型那头一口气吐完，Pi 这头一条一条慢慢处理，
    // 处理到某一条时，事件里带的消息（和模型流共用的那个对象）早就是全文了
    await mkdir(join(root, 'agent', 'extensions'))
    await writeFile(
      join(root, 'agent', 'extensions', 'slow.ts'),
      `export default function (pi) {
  pi.on('message_update', () => new Promise((resolve) => setTimeout(resolve, 1)))
}
`,
    )
    const threadId = (await ok(first, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
    await ok(first, 'turn/start', { threadId, input: [{ type: 'text', text: '说长一点' }] })
    const THINKING = 'item/reasoning/summaryTextDelta'
    const TEXT = 'item/agentMessage/delta'
    const said = (turn: any) => ({
      thinking: turn.items.find((item: any) => item.type === 'reasoning')?.summary[0] ?? '',
      text: turn.items.find((item: any) => item.type === 'agentMessage')?.text ?? '',
    })
    /** 这条连接在第 end 条消息之前收到的增量接起来 */
    const received = (peer: Recorder, end = peer.messages.length) => {
      const before = peer.messages.slice(0, end)
      const joined = (method: string) =>
        before
          .filter((m) => m.method === method)
          .map((m) => m.params.delta)
          .join('')
      return { thinking: joined(THINKING), text: joined(TEXT) }
    }
    const whole = { thinking: thoughts.join(''), text: pieces.join('') }
    await until('正文开始流', () => first.deltas(TEXT).length > 0)
    // 另一条连接这时连上来恢复会话：它拿到的那一份加上之后收到的增量，要正好是全文
    const resumed = said((await ok(late, 'thread/resume', { threadId })).thread.turns.at(-1))
    // 流着的时候不停地读：每次读到的，正好是应答之前已经发给这条连接的增量，不多出还没发的
    let midway = 0
    while (!first.messages.some((m) => m.method === 'turn/completed')) {
      await pause(2)
      const read = await ok(first, 'thread/read', { threadId, includeTurns: true })
      const sent = received(
        first,
        first.messages.findIndex((m) => m.result === read),
      )
      if (read.thread.turns.at(-1).status !== 'inProgress') break
      assert.deepEqual(said(read.thread.turns.at(-1)), sent, '流着的时候读会话')
      if (sent.text.length < whole.text.length) midway++
    }
    await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
    assert.ok(midway > 0, '至少有一次是流到一半时读的')
    assert.deepEqual(received(first), whole)
    const rest = received(late)
    assert.ok(resumed.text.length < whole.text.length, '恢复的时候正文还没流完')
    assert.deepEqual(
      { thinking: resumed.thinking + rest.thinking, text: resumed.text + rest.text },
      whole,
      '恢复时拿到的加上之后的增量',
    )
  })
})

// ---------- 一个回合里调用很多次工具、每次的结果都很大 ----------
// 以前每个不是流式增量的事件（工具调用的开始和结束、消息的开始和结束……）都把整个回合序列化、整行写进库，
// 回合里已有的结果越多，下一次调用越贵，整个回合是条目级的平方。这里不看钟，数的是库：被改了几行、
// 写进去多少个字。不数整个进程的序列化：Pi 每次请求模型都把到现在为止的全部结果序列化一遍（它自己的平方，
// 适配器管不着），检查原生会话有没有被别人改的那个定时器每隔一阵把会话文件整个读一遍比一遍，次数看机器快慢。

/** 一个回合里调用几次工具；倒数第 CALLS - HOLD_CALL 次是一条跑到一半停住的命令，其余都是读同一个文件 */
const CALLS = 80
const HOLD_CALL = 60
/** 每次读回来的文件：四千个字，一行六十个字上下，没超过 Pi 的 read 一次给的量，它原样给回来 */
const FILE = '读到的这一行是工具结果的一部分，每次调用都带回来。const n = 42;\n'
  .repeat(120)
  .slice(0, 4000)

/** 从现在起数这个库：被改了几行，写进去多少个字（写库语句带的字符串参数加起来，写一次回合就是把它序列化一遍写进去） */
function countWrites(db: DatabaseSync): () => { rows: number; chars: number } {
  const changes = () => Number(db.prepare('SELECT total_changes() AS n').get()?.n)
  const rowsBefore = changes()
  let chars = 0
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    const run = statement.run.bind(statement)
    statement.run = ((...values: any[]) => {
      for (const value of values) if (typeof value === 'string') chars += value.length
      return run(...values)
    }) as typeof statement.run
    return statement
  }) as typeof db.prepare
  return () => ({ rows: changes() - rowsBefore, chars })
}

/** 库在这一刻的样子另存一份，用一个新的存储打开：等于进程这时被强杀、重新起来以后看到的 */
async function reopened(server: PiServer, root: string): Promise<PiStore> {
  const home = await mkdtemp(join(root, 'copy-'))
  server.store.db.exec(`VACUUM INTO '${join(home, 'adapter.sqlite')}'`)
  return new PiStore(home)
}

/** 第 done 次请求模型（前面已经有 done 个工具结果）时假模型怎么答：调够了就说一句话收场 */
function callFrames(done: number): string[] {
  if (done >= CALLS) return [frame({ role: 'assistant', content: '都读完了' }), frame({}, 'stop')]
  // 停住的那条命令：先出半句，等工作目录里有了 go 再出后半句
  const command = 'printf 跑到一半; while [ ! -e go ]; do sleep 0.02; done; printf 跑完了'
  const call =
    done === HOLD_CALL
      ? { name: 'bash', arguments: JSON.stringify({ command }) }
      : { name: 'read', arguments: JSON.stringify({ path: 'big.txt' }) }
  const tool_calls = [{ index: 0, id: `call_${done}`, type: 'function', function: call }]
  return [frame({ role: 'assistant', tool_calls }), frame({}, 'tool_calls')]
}
const toolResults = (body: any) => body.messages.filter((m: any) => m.role === 'tool').length

test('STREAM-PI-005：一个回合里八十次调用、每次结果四千字，写库的量按条目算，读到的和内存里的回合一样', {
  timeout: 180_000,
}, async (t) => {
  await scene(
    async (body, res) => {
      for (const text of callFrames(toolResults(body))) res.write(text)
    },
    async ({ server, root, cwd, first, late, ok }) => {
      await writeFile(join(cwd, 'big.txt'), FILE)
      const threadId = (await ok(first, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
      const counted = countWrites(server.store.db)
      const input = [{ type: 'text', text: '把这个文件读很多遍' }]
      const turnId = (await ok(first, 'turn/start', { threadId, input })).turn.id

      // 跑到停住的那条命令：前面的调用都完成了，命令的输出流了一半（这一截只记了一笔、还没写）
      const OUTPUT = 'item/commandExecution/outputDelta'
      await until('命令跑到一半', () => first.deltas(OUTPUT).join('') === '跑到一半')
      const memory = () => JSON.parse(JSON.stringify(server.active.get(threadId)?.turn))
      const read = (await ok(first, 'thread/read', { threadId, includeTurns: true })).thread
      const midway = memory()
      assert.equal(midway.status, 'inProgress')
      const running = midway.items.at(-1)
      assert.deepEqual([running.type, running.aggregatedOutput], ['commandExecution', '跑到一半'])
      assert.equal(
        midway.items.filter((item: any) => item.type === 'mcpToolCall').length,
        HOLD_CALL,
      )
      // 读会话、另一条连接这时来恢复会话：拿到的就是内存里的这个回合（改之前每个事件写一遍整个回合，读到的就是它）
      assert.deepEqual(read.turns.at(-1), midway, '跑到一半时读会话')
      // 逐字一样，连键的先后都一样
      assert.equal(JSON.stringify(read.turns.at(-1)), JSON.stringify(midway))
      const resumed = (await ok(late, 'thread/resume', { threadId })).thread.turns.at(-1)
      assert.equal(JSON.stringify(resumed), JSON.stringify(midway), '跑到一半时恢复会话')
      // 进程这时被强杀：重新起来，这个回合标成被打断，条目一个不少
      const crashed = await reopened(server, root)
      const recovered = crashed.turns(threadId).at(-1)
      crashed.close()
      assert.deepEqual(recovered, {
        ...midway,
        status: 'interrupted',
        completedAt: recovered?.completedAt,
        durationMs: recovered?.durationMs,
      })

      await writeFile(join(cwd, 'go'), '')
      await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
      const { rows, chars } = counted()
      const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
      assert.equal(completed.id, turnId)
      assert.equal(completed.status, 'completed')
      const results = completed.items
        .filter((item: any) => item.type === 'mcpToolCall')
        .map((item: any) => item.result.content[0].text)
      assert.deepEqual(results, Array(CALLS - 1).fill(FILE))
      const command = completed.items.find((item: any) => item.type === 'commandExecution')
      assert.deepEqual([command.status, command.aggregatedOutput], ['completed', '跑到一半跑完了'])
      assert.deepEqual(completed.items.at(-1).text, '都读完了')
      // 前面的条目在回合里没再变过
      assert.deepEqual(completed.items.slice(0, midway.items.length - 1), midway.items.slice(0, -1))
      // 回合一结束，库里存着的（重新打开读）就是这个回合，一字不差
      const disk = await reopened(server, root)
      assert.equal(JSON.stringify(disk.turns(threadId).at(-1)), JSON.stringify(completed))
      disk.close()
      // 之后再读会话，入口按原生会话把回合重新投影一遍（回合上多出 clientId），条目和回合结束时的一样
      const stored = (await ok(first, 'thread/read', { threadId, includeTurns: true })).thread
      assert.deepEqual(stored.turns.at(-1).items, completed.items, '回合结束后读会话')

      // 全部结果加起来多少个字。每个条目写一两遍、回合结束时整个写一遍，是它的几倍；
      // 每来一种事件就写一遍整个回合的话，单这一种就是调用次数乘它的一半，每次调用有七八个这样的事件
      const size = CALLS * FILE.length
      const linear = size * 4 + CALLS * 2000
      t.diagnostic(
        `${CALLS} 次调用、结果一共 ${size} 个字：库被改了 ${rows} 行，写进去 ${chars} 个字（上限 ${linear}）`,
      )
      assert.ok(linear * 4 < (CALLS * size) / 2, '这个上限得比平方级的量小得多才有意义')
      assert.ok(chars < linear, `回合期间写进库 ${chars} 个字，上限 ${linear}`)
      // 行数也按条目算：只写变了的条目，不是每次把回合里的条目都写一遍
      assert.ok(rows < CALLS * 12, `回合期间库被改了 ${rows} 行，调用了 ${CALLS} 次`)
    },
  )
})

test('STREAM-PI-006：回合被打断、出错时，库里存着的是完整的回合', {
  timeout: 120_000,
}, async () => {
  /** 读三次文件之后：interrupted 是跑一条停住的命令、等着被打断，failed 是模型请求断掉 */
  for (const ending of ['interrupted', 'failed'] as const)
    await scene(
      async (body, res) => {
        const done = toolResults(body)
        if (done < 3) for (const text of callFrames(done)) res.write(text)
        else if (ending === 'interrupted') for (const text of callFrames(HOLD_CALL)) res.write(text)
        else res.destroy()
      },
      async ({ server, root, cwd, first, ok }) => {
        await writeFile(join(cwd, 'big.txt'), FILE)
        const threadId = (await ok(first, 'thread/start', { cwd, model: 'gate/gate' })).thread.id
        const input = [{ type: 'text', text: '读三遍' }]
        await ok(first, 'turn/start', { threadId, input })
        if (ending === 'interrupted') {
          const OUTPUT = 'item/commandExecution/outputDelta'
          await until('命令跑到一半', () => first.deltas(OUTPUT).join('') === '跑到一半')
          await ok(first, 'turn/interrupt', { threadId })
        }
        await until('回合结束', () => first.messages.some((m) => m.method === 'turn/completed'))
        const completed = first.messages.find((m) => m.method === 'turn/completed').params.turn
        assert.equal(completed.status, ending)
        const results = completed.items.filter((item: any) => item.type === 'mcpToolCall')
        assert.deepEqual(
          results.map((item: any) => item.result.content[0].text),
          [FILE, FILE, FILE],
        )
        const disk = await reopened(server, root)
        assert.deepEqual(disk.turns(threadId).at(-1), completed, `${ending}：库里存着的`)
        disk.close()
      },
    )
})
