// 给客户端开发和自检用的隔离入口：在临时目录里起一个 Pi 引擎，模型请求全部打到本机回环上的假模型，
// 再经协议真的跑几个回合，造出带历史的会话。客户端连上它看到的是真实的入口、真实的会话记录，
// 但不碰用户自己的会话，也不用任何模型凭据。
//
// 用法：node scripts/client-fixture.mjs [--ws 端口]
//   默认监听临时目录里的 unix 套接字；--ws 改成监听回环上的端口（只给浏览器里调界面用）。
//   就绪后输出一行 LITCH_FIXTURE {"entry": "...", "root": "..."}，然后一直运行到被结束，退出时清掉临时目录。
//   会话造完之后再发消息：话里带“改个文件”时，假模型会调 bash 工具在会话的工作目录里接着写一个文件、
//   新写一个文件（见 client-fixture-edit.mjs），差异面板的验收拿它看“代理改完，回合结束后面板自己跟上”。
//   话里带“回声”时，假模型调用桌面端提供的客户端工具 litch_echo.echo，把结果原样说出来（见 client-fixture-echo.mjs），
//   客户端工具的自检拿它看工具调用经引擎回到桌面端、结果再回到模型。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { ASK_TOOL, askOffered, askReply, installAskExtension } from './client-fixture-ask.mjs'
import { echoReply } from './client-fixture-echo.mjs'
import { editReply } from './client-fixture-edit.mjs'
import { planReply } from './client-fixture-plan.mjs'
import { seedSessions } from './client-fixture-seed.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(repo, 'packages/pi/dist/pi/src/adapter.mjs')
if (!existsSync(engine)) {
  console.error('没有找到 Pi 引擎的构建产物，请先运行 npm run build --prefix packages/pi')
  process.exit(1)
}
const piPackage = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
const piCli = join(piPackage, dirname(piEntry), 'cli.js')

const wsIndex = process.argv.indexOf('--ws')
const wsPort = wsIndex < 0 ? null : Number(process.argv[wsIndex + 1])

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync(join(tmpdir(), 'litch-fx-'))
const dirs = {
  agent: join(root, 'agent'),
  state: join(root, 'state'),
  home: join(root, 'home'),
  app: join(root, 'work/app'),
  web: join(root, 'work/app/web'),
  notes: join(root, 'notes'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

// ---------- 假模型 ----------
// 每次模型请求从队列里取一个回复；队列空了就回一句固定的话。
const replies = []
let requests = 0
// 会话造完之后再来的请求，是有人在界面上发消息：把这句话带回去，一段一段慢慢发，
// 界面上看得到流式输出，排队和打断也来得及试。话里带“问我”的，先向用户提两个问题（见 client-fixture-ask.mjs）。
// 计划模式开着、话里带“出个计划”的，交一份计划（见 client-fixture-plan.mjs）。
let paced = false
// 引擎有没有把提问的工具交给模型。造完会话还是没有，说明那个小扩展没装载上
let askReady = false
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
/** 请求里用户说的最后一句话 */
const lastUserText = (body) => {
  const content = body.messages?.findLast((message) => message.role === 'user')?.content
  if (typeof content === 'string') return content
  return (content ?? []).map((part) => part.text ?? '').join('')
}
/** 用户最后一条消息里带了几张图 */
const lastUserImages = (body) => {
  const content = body.messages?.findLast((message) => message.role === 'user')?.content
  return Array.isArray(content) ? content.filter((part) => part.type === 'image_url').length : 0
}
const model = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  requests++
  askReady ||= askOffered(body)
  const reply =
    replies.shift() ??
    (paced
      ? (planReply(body, lastUserText(body)) ??
        editReply(body, lastUserText(body)) ??
        echoReply(body, lastUserText(body)) ??
        askReply(body, lastUserText(body)) ?? {
          text: `收到：${lastUserText(body)}${lastUserImages(body) ? `（图 ${lastUserImages(body)} 张）` : ''}\n\n这是隔离入口里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`,
          pace: 200,
        })
      : { text: '好的。' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const base = {
    id: `mock_${requests}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: body.model,
  }
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    )
  for (const text of reply.thinking ?? []) chunk({ reasoning_content: text })
  const calls = reply.tools?.map((tool, index) => ({
    index,
    id: `call_${requests}_${index}`,
    type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
  }))
  if (calls) {
    chunk({ role: 'assistant', tool_calls: calls })
  } else {
    // 文字分几段发，让适配器那边产生真实的增量
    const text = reply.text ?? '好的。'
    const size = Math.max(1, Math.ceil(text.length / 6))
    for (let at = 0; at < text.length; at += size) {
      chunk(
        at === 0
          ? { role: 'assistant', content: text.slice(0, size) }
          : { content: text.slice(at, at + size) },
      )
      if (reply.pace) await pause(reply.pace)
      // 回合被打断时对面会断开这个请求，后面的不用发了
      if (res.destroyed) return
    }
  }
  chunk({}, calls ? 'tool_calls' : 'stop', {
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  res.end('data: [DONE]\n\n')
})
await new Promise((done) => model.listen(0, '127.0.0.1', done))

writeFileSync(
  join(dirs.agent, 'models.json'),
  JSON.stringify({
    providers: {
      gate: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: 'openai-completions',
        apiKey: 'fixture-only',
        models: [
          {
            id: 'gate',
            name: 'Gate',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
)
writeFileSync(
  join(dirs.agent, 'settings.json'),
  JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
)
installAskExtension(dirs.agent)
// 一项造出来的技能：客户端验收时从输入框里的单子上选它，随消息发出去。
// 假模型会把收到的话带回来，正文里的记号出现在回话里就说明技能真的到了模型手里
const SKILL = 'fixture-notes'
mkdirSync(join(dirs.agent, 'skills', SKILL), { recursive: true })
writeFileSync(
  join(dirs.agent, 'skills', SKILL, 'SKILL.md'),
  [
    '---',
    `name: ${SKILL}`,
    'description: 隔离入口里造出来的技能，验收输入框里的单子用',
    '---',
    '',
    '这是隔离入口里的技能正文。记号：LITCH-SKILL-7391。',
    '',
  ].join('\n'),
)

// ---------- 引擎 ----------
const socket = join(root, 'runtime.sock')
const listen = wsPort ? `ws://127.0.0.1:${wsPort}` : `unix://${socket}`
// 环境只给必需的几项，不继承用户的任何凭据和配置
const child = spawn(process.execPath, [engine, 'app-server', '--listen', listen], {
  env: {
    PATH: process.env.PATH,
    HOME: dirs.home,
    TMPDIR: root,
    CHA_PI_HOME: dirs.state,
    PI_CODING_AGENT_DIR: dirs.agent,
    PI_CLI: piCli,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let engineLog = ''
child.stderr.on('data', (data) => {
  engineLog = (engineLog + data).slice(-4000)
})

let cleaned = false
const cleanup = (code) => {
  if (cleaned) return
  cleaned = true
  child.kill('SIGTERM')
  model.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))
child.on('exit', (code) => {
  if (cleaned) return
  console.error(`引擎退出了（退出码 ${code}）\n${engineLog}`)
  cleanup(1)
})

// ---------- 作为客户端连上去，造会话 ----------
const connect = async () => {
  const url = wsPort ? listen : `ws+unix://${socket}:/`
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await new Promise((done, fail) => {
        const ws = new WebSocket(url)
        ws.once('open', () => done(ws))
        ws.once('error', fail)
      })
    } catch {
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  throw new Error('等了 30 秒，引擎还没有开始监听')
}

try {
  const ws = await connect()
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.method && message.id !== undefined) {
      // 造数据时不处理对面的请求，回一个错误让它别等
      ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'fixture' } }))
    } else if (message.method) {
      for (const listener of listeners) listener(message)
    } else {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry?.fail(new Error(`${entry.method}: ${message.error.message}`))
      else entry?.done(message.result)
    }
  })
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++
      pending.set(id, { done, fail, method })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const waitFor = (predicate) =>
    new Promise((done) => {
      const listener = (message) => {
        if (!predicate(message)) return
        listeners.delete(listener)
        done(message)
      }
      listeners.add(listener)
    })
  await call('initialize', {
    clientInfo: { name: 'litch-fixture', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  await seedSessions({ call, waitFor, replies, dirs })
  if (!askReady) throw new Error(`引擎没有把提问的工具（${ASK_TOOL}）交给模型，扩展没有装载上`)
  paced = true
  ws.close()
} catch (error) {
  console.error(`造会话失败：${error?.stack ?? error}\n${engineLog}`)
  cleanup(1)
}

console.log(`LITCH_FIXTURE ${JSON.stringify({ entry: listen, root })}`)
console.log('隔离入口已就绪，按 Ctrl+C 结束并清理。')
