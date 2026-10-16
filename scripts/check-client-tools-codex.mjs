// 对着这台机器上真的 codex 检查“原生 codex 的客户端工具调用由设备进程挑执行方”
// （clientTools 扩展，protocol/extensions/client-tools.json；实现在 packages/device/src/client-tools.mts）。
// 真的适配器主进程（Go，现编到临时目录里）+ 真的设备进程 + PATH 里的 codex，两个客户端只连聚合面：
//   - litch：声明了 clientTools、能执行 litch_echo，带着这个命名空间的工具新建会话；
//   - desktop：什么都没声明（当作官方桌面端），恢复同一个会话、发起回合。
// 模型调 litch_echo 时 codex 把调用发给两条连接，设备进程只转给 litch；litch 答的文字和图片交到模型手里。
// 然后 litch 断开，desktop 再发起一个要调工具的回合：设备进程当场替它回 noExecutor，回合照常结束。
// CI 上没有 codex，自动化测试用的是假的 codex（packages/device/test/client-tools.test.mts）；这一条在本机跑。
//
// 用法：node scripts/check-client-tools-codex.mjs（先 npm run build --prefix packages/device；需要本机有 go）
//   PATH 里没有 codex 时说明原因后跳过（退出码 0）。
// 隔离照 scripts/check-native-codex.mjs：HOME、CODEX_HOME 都在临时目录，环境从零写，模型是回环上的假接口，
// 代理指到回环上没人听的端口；不碰 ~/.codex 和 ~/.codex-harness-adapter；结束时收掉进程、删掉临时目录。
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

/** PATH 里第一个可执行的 codex。官方桌面端自带的那一份不算 */
function findCodex() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, 'codex')
    try {
      if (!statSync(candidate).isFile() || (statSync(candidate).mode & 0o111) === 0) continue
      if (realpathSync(candidate).startsWith('/Applications/')) continue
      return candidate
    } catch {
      // 这个目录里没有
    }
  }
  return null
}

const codex = findCodex()
if (!codex) {
  console.log(
    '跳过：PATH 里没有 codex 命令行（官方桌面端自带的那一份不算），这一条检查要它才能跑。',
  )
  process.exit(0)
}
if (process.platform === 'win32') {
  console.log('跳过：Windows 上还不能把原生 Codex 接进来。')
  process.exit(0)
}
if (!existsSync(join(repo, 'packages/device/dist/device/src/main.mjs'))) {
  console.error('没有找到设备进程的构建产物，请先运行 npm run build --prefix packages/device')
  process.exit(1)
}

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync('/tmp/lct-')
const dirs = {
  userHome: join(root, 'h'),
  codexHome: join(root, 'c'),
  tmp: join(root, 't'),
  adapterHome: join(root, 'a'),
  work: join(root, 'w'),
}
for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true })
const runtimeSocket = join(dirs.adapterHome, 'codex', 'runtime.sock')
const deviceSocket = join(dirs.adapterHome, 'device', 'device.sock')

const ECHO = 'litch_echo'
const TOOLS = [
  {
    type: 'namespace',
    name: ECHO,
    description: 'Litch 测试工具',
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  },
]
// 1x1 的 PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ---------- 假模型：回环上的 Responses 接口 ----------
// 用户的话里有“调用工具”、工具表里有 litch_echo、上一项还不是工具结果时，调一次它；否则回一句话。
// 每次请求的最后一项记下来，用来看工具结果交到模型手里没有
const lastInputs = []
let modelRequests = 0
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  } catch {
    // 不是 JSON：照空的处理
  }
  if (request.method !== 'POST' || !(request.url ?? '').endsWith('/responses')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":{"message":"not found"}}')
    return
  }
  const count = ++modelRequests
  const input = Array.isArray(body.input) ? body.input : []
  const last = input.at(-1)
  lastInputs.push(last)
  const said = JSON.stringify(input.findLast((item) => item.role === 'user') ?? {})
  const tool = (body.tools ?? []).find((entry) => entry.type === 'namespace' && entry.name === ECHO)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  emit({ type: 'response.created', response: { id: `resp_${count}` } })
  if (said.includes('调用工具') && tool && last?.type !== 'function_call_output') {
    emit({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: `call_${count}`,
        namespace: ECHO,
        name: tool.tools[0].name,
        arguments: JSON.stringify({ text: 'hi' }),
      },
    })
  } else {
    const text = `ok ${count}`
    const item = { type: 'message', role: 'assistant', id: `msg_${count}`, phase: 'final_answer' }
    emit({ type: 'response.output_item.added', item: { ...item, content: [] } })
    emit({ type: 'response.output_text.delta', delta: text })
    emit({
      type: 'response.output_item.done',
      item: { ...item, content: [{ type: 'output_text', text }] },
    })
  }
  const usage = {
    input_tokens: 10,
    input_tokens_details: null,
    output_tokens: 5,
    output_tokens_details: null,
    total_tokens: 15,
  }
  emit({ type: 'response.completed', response: { id: `resp_${count}`, usage } })
  response.end()
})
await new Promise((done) => model.listen(0, '127.0.0.1', done))
writeFileSync(
  join(dirs.codexHome, 'config.toml'),
  [
    'model = "fake-model"',
    'model_provider = "fake"',
    '',
    '[model_providers.fake]',
    'name = "Fake"',
    `base_url = "http://127.0.0.1:${model.address().port}/v1"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'),
)

/** 主进程（和它起的 codex）用的环境：从零写的，不继承这个进程的任何变量 */
const DEAD_PROXY = 'http://127.0.0.1:9'
const isolated = {
  HOME: dirs.userHome,
  CODEX_HOME: dirs.codexHome,
  TMPDIR: dirs.tmp,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  all_proxy: DEAD_PROXY,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  CHA_LANG: 'zh-CN',
  CHA_CLAUDE_CLI: join(root, 'no-claude'),
  PI_CLI: join(root, 'no-pi'),
}

// ---------- 聚合面上的客户端 ----------
async function connect(name, capabilities) {
  const ws = new WebSocket(`ws+unix://${deviceSocket}:/`)
  await new Promise((done, fail) => {
    ws.once('open', done)
    ws.once('error', fail)
  })
  const pending = new Map()
  const incoming = []
  const waiters = new Set()
  let nextId = 1
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    if (typeof frame.method !== 'string') {
      const entry = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) entry?.fail(Object.assign(new Error(frame.error.message), frame.error))
      else entry?.done(frame.result)
      return
    }
    incoming.push(frame)
    for (const waiter of [...waiters]) if (waiter(frame)) waiters.delete(waiter)
  })
  const client = {
    incoming,
    call(method, params) {
      const id = nextId++
      return new Promise((done, fail) => {
        pending.set(id, { done, fail })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    answer: (id, result) => ws.send(JSON.stringify({ id, result })),
    waitFor(what, predicate, timeoutMs = 60_000) {
      const seen = incoming.find(predicate)
      if (seen) return Promise.resolve(seen)
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          fail(new Error(`${name} 等了 ${timeoutMs / 1000} 秒没有等到：${what}`))
        }, timeoutMs)
        const waiter = (frame) => {
          if (!predicate(frame)) return false
          clearTimeout(timer)
          done(frame)
          return true
        }
        waiters.add(waiter)
      })
    },
    toolCalls: () => incoming.filter((frame) => frame.method === 'item/tool/call'),
    close: () => ws.close(),
  }
  await client.call('initialize', {
    clientInfo: { name, title: null, version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false, ...capabilities },
  })
  return client
}

// ---------- 起真的主进程 ----------
const binary = join(root, 'cha')
const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
  cwd: repo,
  encoding: 'utf8',
})
let service = null
let output = ''
let physicalSocket = null

function stopService() {
  const child = service
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.once('exit', () => {
      clearTimeout(force)
      done()
    })
    child.kill('SIGTERM')
  })
}

/** 命令行里带着这个临时目录的进程：都是这次检查起的 */
function leftovers() {
  const found = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' })
  return found.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

const expect = (condition, what) => {
  if (!condition) throw new Error(`不符合预期：${what}`)
}
const passed = (line) => console.log(`✔ ${line}`)
const text = (value) => [{ type: 'text', text: value, text_elements: [] }]

async function main() {
  if (built.status !== 0)
    throw new Error(`适配器主进程没有编出来（需要本机有 go）：${built.stderr || built.error}`)
  service = spawn(
    binary,
    ['start', '--home', dirs.adapterHome, '--root', repo, '--node', process.execPath, '--ssh=off'],
    { env: isolated, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const stream of [service.stdout, service.stderr])
    stream.on('data', (data) => {
      output += data
    })
  for (let attempt = 0; !existsSync(deviceSocket); attempt++) {
    if (service.exitCode !== null) throw new Error('适配器主进程提前退出了')
    if (attempt > 600) throw new Error('等了 60 秒，聚合面的套接字还没有出现')
    await pause(100)
  }
  const litch = await connect('litch-check', {
    litchExtensions: ['harness', 'deviceSettings', 'clientTools'],
    litchClientTools: { namespaces: [ECHO] },
  })
  // 在设置里打开 Codex，命令行路径写明是 PATH 里找到的那个
  const { snapshot } = await litch.call('litch/device/settings/read')
  const written = await litch.call('litch/device/settings/write', {
    expectedVersion: snapshot.version,
    edits: [
      { key: 'harness.codex.enabled', value: true },
      { key: 'harness.codex.cliPath', value: codex },
    ],
  })
  if (!written.restarted.includes('codex'))
    await litch.call('litch/device/harness/restart', { harness: 'codex', force: true })
  let info = null
  for (let attempt = 0; attempt < 300; attempt++) {
    info = (await litch.call('runtime/info')).harnesses.find((item) => item.id === 'codex')
    if (info?.available) break
    await pause(100)
  }
  expect(info?.available, `Codex 应该可用：${JSON.stringify(info?.unavailable)}`)
  expect(info.extensions?.includes('clientTools'), `声明里应有 clientTools：${info.extensions}`)
  passed(`Codex ${info.version} 可用，经聚合面报 clientTools`)
  try {
    physicalSocket = resolve(dirname(runtimeSocket), readlinkSync(runtimeSocket))
  } catch {
    // 这一版的 codex 直接在给的路径上建套接字
  }
  // 当作官方桌面端：只声明聚合面必需的扩展
  const desktop = await connect('desktop-check', { litchExtensions: ['harness'] })

  const started = await litch.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':workspace',
    dynamicTools: TOOLS,
  })
  const threadId = started.thread.id
  const turnDone = (client, turnId) =>
    client.waitFor(
      `回合 ${turnId} 结束`,
      (frame) => frame.method === 'turn/completed' && frame.params.turn.id === turnId,
    )
  // 会话记录要等第一个回合才落盘，之前恢复不了（实测 0.160.0：no rollout found）：先跑一个不调工具的回合
  const warm = await litch.call('turn/start', { threadId, input: text('你好') })
  await turnDone(litch, warm.turn.id)
  await desktop.call('thread/resume', { threadId })

  // 一：桌面端发起，Litch 执行
  const first = await desktop.call('turn/start', { threadId, input: text('请调用工具') })
  const call = await litch.waitFor('item/tool/call', (frame) => frame.method === 'item/tool/call')
  expect(
    call.params.namespace === ECHO && call.params.threadId === threadId,
    `调用参数不对：${JSON.stringify(call.params)}`,
  )
  litch.answer(call.id, {
    success: true,
    contentItems: [
      { type: 'inputText', text: 'ECHO hi' },
      { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` },
    ],
  })
  const done = await turnDone(desktop, first.turn.id)
  expect(done.params.turn.status === 'completed', `回合没有正常结束：${done.params.turn.status}`)
  const handed = JSON.stringify(lastInputs.at(-1))
  expect(handed.includes('ECHO hi'), `模型没有拿到工具结果：${handed.slice(0, 300)}`)
  expect(handed.includes(PNG), '工具结果里的图片没有交到模型手里')
  expect(desktop.toolCalls().length === 0, '没声明的桌面端不该收到调用')
  passed(`桌面端发起的回合里，调用只交给了 Litch（请求号 ${call.id}），文字和图片都到了模型`)

  // 二：Litch 断开，桌面端再发起：设备进程当场替它回 noExecutor
  litch.close()
  await pause(300)
  const second = await desktop.call('turn/start', { threadId, input: text('再请调用工具') })
  const ended = await turnDone(desktop, second.turn.id)
  expect(ended.params.turn.status === 'completed', `回合没有正常结束：${ended.params.turn.status}`)
  const failed = JSON.stringify(lastInputs.at(-1))
  expect(failed.includes('[litch:noExecutor]'), `模型应拿到 noExecutor：${failed.slice(0, 300)}`)
  expect(desktop.toolCalls().length === 0, '桌面端仍不该收到调用')
  passed('没有 Litch 连着时，设备进程当场回 noExecutor，回合照常结束')
  desktop.close()
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
}
if (failure) {
  console.error(`✖ ${failure.message}`)
  console.error(`\n主进程的输出（末尾）：\n${output.split('\n').slice(-40).join('\n')}`)
}
await stopService()
await pause(300)
const left = leftovers()
for (const pid of left) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经退出了
  }
}
model.closeAllConnections()
model.close()
if (physicalSocket)
  for (const path of [physicalSocket, `${physicalSocket}.lock`]) rmSync(path, { force: true })
rmSync(root, { recursive: true, force: true })
if (left.length > 0) {
  console.error(`✖ 主进程退出之后还留着 ${left.length} 个进程（已强杀）：${left.join('、')}`)
  process.exit(1)
}
if (failure) process.exit(1)
console.log(
  `检查通过：模型请求 ${modelRequests} 次，都打在回环上的假模型；没有留下进程和临时文件。`,
)
