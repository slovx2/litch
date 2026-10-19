// 对着这台机器上真的 opencode 检查 OpenCode 和通用 ACP 两个入口接进聚合面的整条链：
// 真的适配器主进程（Go，现编到临时目录里）管着设备进程、OpenCode 运行时（它再起 opencode serve）、
// 自填命令的 ACP 运行时（它再起 opencode acp），客户端只连聚合面（声明 harness 扩展）。
// 隔离环境就是 scripts/device-fixture.mjs --managed --engines opencode,acp 起的那一份，这里只当客户端：
//   runtime/info 里 opencode、acp 可用，gemini、qwen 是“已停用”（不跑它们的回合：真的 agent 会花钱）；
//   opencode：新建会话跑一个回合、回话对得上；一次命令审批批准（命令真的跑了、审批对得上命令条目），
//             一次拒绝（条目是 declined、命令没跑）；会话列表里有它，读回来几个回合都在；
//   acp：新建会话跑一个回合、回话对得上，会话列表里有它；
//   详情设置（harnessConfig）：经聚合面读 OpenCode 的配置项、写一项再读回、读 provider 并用假 key 连上再断开、
//             读指令文件，文件都落在夹具的临时目录里。设备进程还不转 litch/harness/* 时说明后跳过这一段。
// 不进流水线（流水线上没有 opencode），在本机跑。
//
// 用法：npm run client:check:opencode
//   先 npm run build（要 packages/pi、device、opencode、acp 的构建产物），本机要有 go。
//   opencode 按 CHA_OPENCODE_CLI、PATH、~/.opencode/bin/opencode 的次序找，都没有就说明原因后跳过（退出码 0）。
//
// 隔离（做法在 device-fixture.mjs 和 client-fixture-engines.mjs 开头）：主目录、XDG 目录、临时目录、适配器的状态目录
// 都在夹具的临时目录里，不碰 ~/.codex-harness-adapter、~/.config/opencode、~/.local/share/opencode；
// 模型是回环上的假模型，npm 源和代理指到连不通的回环端口。结束时夹具停掉它起的全部进程并删掉临时目录，
// 这里再按临时目录的路径查一遍有没有留下进程。
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, rmSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { RUN_MARK } from './client-fixture-run.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 用户装的 opencode：次序和 OpenCode 引擎自己找的一样 */
function findOpencode() {
  const configured = process.env.CHA_OPENCODE_CLI?.trim()
  if (configured) return executable(configured) ? configured : null
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory && executable(join(directory, 'opencode'))) return join(directory, 'opencode')
  }
  const fallback = join(homedir(), '.opencode', 'bin', 'opencode')
  return executable(fallback) ? fallback : null
}

const opencode = findOpencode()
if (!opencode) {
  console.log(
    '跳过：没有找到 opencode（CHA_OPENCODE_CLI、PATH、~/.opencode/bin 都没有），这一条检查要它才能跑。',
  )
  process.exit(0)
}
if (process.platform === 'win32') {
  console.log('跳过：夹具还不支持 Windows。')
  process.exit(0)
}
const missing = ['pi', 'device', 'opencode', 'acp'].filter((name) => {
  const entry = name === 'device' ? 'main.mjs' : 'adapter.mjs'
  return !existsSync(join(repo, `packages/${name}/dist/${name}/src/${entry}`))
})
if (missing.length > 0) {
  console.error(
    `没有找到 ${missing.map((name) => `packages/${name}`).join('、')} 的构建产物，请先运行 npm run build`,
  )
  process.exit(1)
}
if (spawnSync('go', ['version']).status !== 0) {
  console.error('本机没有 go：夹具要现编适配器主进程')
  process.exit(1)
}

// ---------- 起夹具 ----------
const fixture = spawn(
  process.execPath,
  [join(repo, 'scripts/device-fixture.mjs'), '--managed', '--engines', 'opencode,acp'],
  {
    cwd: repo,
    env: { ...process.env, CHA_OPENCODE_CLI: opencode, CHA_ACP_CLI: opencode, CHA_ACP_ARGS: 'acp' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let fixtureOutput = ''
const ready = new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error('等了 240 秒，夹具还没有就绪')), 240_000)
  const look = (data) => {
    fixtureOutput += data
    const line = fixtureOutput
      .split('\n')
      .find((entry) => entry.startsWith('LITCH_DEVICE_FIXTURE '))
    if (!line) return
    clearTimeout(timer)
    done(JSON.parse(line.slice('LITCH_DEVICE_FIXTURE '.length)))
  }
  fixture.stdout.on('data', look)
  fixture.stderr.on('data', look)
  fixture.once('exit', (code, signal) => {
    clearTimeout(timer)
    fail(new Error(`夹具提前退出了（${signal ?? `退出码 ${code}`}）`))
  })
})

/** 结束夹具：它自己停掉主进程（主进程再收掉各运行时和 opencode）并删临时目录 */
function stopFixture() {
  if (fixture.exitCode !== null || fixture.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const force = setTimeout(() => fixture.kill('SIGKILL'), 60_000)
    fixture.once('exit', () => {
      clearTimeout(force)
      done()
    })
    fixture.kill('SIGTERM')
  })
}

/** 命令行里带着夹具临时目录的进程：都是这次检查起的 */
function leftovers(root) {
  const found = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' })
  return found.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

// ---------- 聚合面上的客户端 ----------
async function connect(path) {
  // 路径不写进地址（会被转义），经 createConnection 连
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => net.createConnection(path),
  })
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
  return {
    incoming,
    call(method, params) {
      const id = nextId++
      return new Promise((done, fail) => {
        pending.set(id, { done, fail, method })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    notify: (method) => ws.send(JSON.stringify({ method })),
    answer: (id, result) => ws.send(JSON.stringify({ id, result })),
    /** 等一帧对面主动发来的（通知或请求）。from：只看这个位置之后收到的 */
    waitFor(what, predicate, from = 0, timeoutMs = 90_000) {
      const seen = incoming.slice(from).find(predicate)
      if (seen) return Promise.resolve(seen)
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          fail(new Error(`等了 ${timeoutMs / 1000} 秒没有等到：${what}`))
        }, timeoutMs)
        const waiter = (frame) => {
          if (incoming.indexOf(frame) < from || !predicate(frame)) return false
          clearTimeout(timer)
          done(frame)
          return true
        }
        waiters.add(waiter)
      })
    },
    close: () => ws.close(),
  }
}

// ---------- 检查 ----------
const expect = (condition, what) => {
  if (!condition) throw new Error(`不符合预期：${what}`)
}
const passed = (line) => console.log(`✔ ${line}`)
const text = (value) => [{ type: 'text', text: value, text_elements: [] }]

/**
 * 跑一个回合，直到它结束。onApproval 给来的每一个审批请求作答（返回应答的 result）；
 * 返回结束的回合、这一回合里完成的条目和来过的审批请求
 */
async function runTurn(client, threadId, said, onApproval = null) {
  const mark = client.incoming.length
  const ofThread = (frame) => frame.params?.threadId === threadId
  await client.call('turn/start', { threadId, input: text(said) })
  const approvals = []
  for (;;) {
    const frame = await client.waitFor(
      `“${said}”这一回合结束`,
      (entry) =>
        ofThread(entry) &&
        (entry.method === 'turn/completed' ||
          (entry.id !== undefined &&
            entry.method.endsWith('/requestApproval') &&
            !approvals.includes(entry))),
      mark,
    )
    if (frame.method === 'turn/completed') {
      const items = client.incoming
        .slice(mark)
        .filter((entry) => entry.method === 'item/completed' && ofThread(entry))
        .map((entry) => entry.params.item)
      return { turn: frame.params.turn, items, approvals, mark }
    }
    approvals.push(frame)
    expect(onApproval, `这一回合不该来问审批：${frame.method}`)
    client.answer(frame.id, onApproval(frame))
  }
}

const replyOf = (items) => items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? ''

async function main() {
  const fixtureInfo = await ready
  const cwd = fixtureInfo.engines.cwd
  const client = await connect(fixtureInfo.socket)
  await client.call('initialize', {
    clientInfo: { name: 'litch-check-opencode', title: null, version: '0.0.1' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      litchExtensions: ['harness', 'deviceSettings', 'declineWithNote', 'harnessConfig'],
    },
  })
  client.notify('initialized')

  // runtime/info：两个要的都可用，经 ACP 接的另两个在设置里停用着
  const { harnesses } = await client.call('runtime/info')
  const harness = (id) => harnesses.find((item) => item.id === id)
  for (const id of ['opencode', 'acp']) {
    const info = harness(id)
    expect(info?.available === true, `${id} 应该可用：${JSON.stringify(info?.unavailable ?? info)}`)
  }
  for (const id of ['gemini', 'qwen'])
    expect(
      harness(id)?.unavailable?.kind === 'disabled',
      `${id} 应该是已停用：${JSON.stringify(harness(id))}`,
    )
  passed(
    `runtime/info：opencode ${harness('opencode').version} 可用，acp ${harness('acp').version} 可用，gemini、qwen 已停用`,
  )

  // OpenCode：新建会话、跑一个回合
  const started = await client.call('thread/start', {
    harness: 'opencode',
    cwd,
    permissions: ':workspace',
  })
  const threadId = started.thread.id
  expect(started.thread.harness === 'opencode', `会话应标着 opencode：${started.thread.harness}`)
  const hello = await runTurn(client, threadId, '你好，OpenCode')
  expect(hello.turn.status === 'completed', `回合没有正常结束：${JSON.stringify(hello.turn)}`)
  expect(
    replyOf(hello.items).startsWith('opencode 收到：你好，OpenCode'),
    `回话不对：${replyOf(hello.items)}`,
  )
  passed(`opencode 新建会话（${started.model}）并跑完一个回合，回话对得上`)

  // 命令审批：批准，命令真的跑了，审批的 itemId 就是那个命令条目
  const ran = join(cwd, RUN_MARK)
  rmSync(ran, { force: true })
  const accepted = await runTurn(client, threadId, '跑个命令', () => ({ decision: 'accept' }))
  const command = accepted.items.find((item) => item.type === 'commandExecution')
  expect(
    accepted.turn.status === 'completed',
    `批准之后回合没有正常结束：${JSON.stringify(accepted.turn)}`,
  )
  expect(accepted.approvals.length === 1, `应该来问一次审批，来了 ${accepted.approvals.length} 次`)
  const asked = accepted.approvals[0]
  expect(
    asked.method === 'item/commandExecution/requestApproval',
    `审批的种类不对：${asked.method}`,
  )
  expect(
    command?.status === 'completed' && command.aggregatedOutput?.includes('fixture-ran-42'),
    `命令条目不对：${JSON.stringify(command)}`,
  )
  expect(
    asked.params.itemId === command.id,
    `审批的 itemId ${asked.params.itemId} 对不上命令条目 ${command.id}`,
  )
  expect(existsSync(ran), '批准之后命令应该跑了')
  await client.waitFor(
    '审批有结果的通知',
    (frame) => frame.method === 'serverRequest/resolved' && frame.params.threadId === threadId,
    accepted.mark,
  )
  passed(
    `命令审批（批准）：决定列表 ${JSON.stringify(asked.params.availableDecisions)}，审批对得上命令条目，命令跑了`,
  )

  // 命令审批：拒绝，条目是 declined，命令没跑
  rmSync(ran, { force: true })
  const declined = await runTurn(client, threadId, '跑个命令', () => ({ decision: 'decline' }))
  const refused = declined.items.find((item) => item.type === 'commandExecution')
  expect(
    declined.turn.status === 'completed',
    `拒绝之后回合没有正常结束：${JSON.stringify(declined.turn)}`,
  )
  expect(declined.approvals.length === 1, `应该来问一次审批，来了 ${declined.approvals.length} 次`)
  expect(
    refused?.status === 'declined',
    `拒绝之后命令条目应是 declined：${JSON.stringify(refused)}`,
  )
  expect(!existsSync(ran), '拒绝之后命令不该跑')
  passed('命令审批（拒绝）：条目是 declined，命令没跑，模型拿到拒绝接着回话')

  // 会话列表、读回来
  const list = await client.call('thread/list', { limit: 50 })
  expect(
    list.data.some((thread) => thread.id === threadId && thread.harness === 'opencode'),
    `会话列表里没有它：${JSON.stringify(list.data.map((thread) => [thread.id, thread.harness]))}`,
  )
  expect(
    list.skippedHarnesses.every((entry) => entry.harness !== 'opencode' && entry.harness !== 'acp'),
    `opencode、acp 不该被跳过：${JSON.stringify(list.skippedHarnesses)}`,
  )
  const read = await client.call('thread/read', { threadId, includeTurns: true })
  expect(
    read.thread.turns.length === 3 &&
      read.thread.turns.every((turn) => turn.status === 'completed'),
    `读回来的回合不对：${JSON.stringify(read.thread.turns.map((turn) => turn.status))}`,
  )
  passed('opencode 的会话在会话列表里，读回来三个回合都在')

  // acp（opencode acp）：新建会话、跑一个回合、会话列表里有它
  const viaAcp = await client.call('thread/start', { harness: 'acp', cwd })
  expect(viaAcp.thread.harness === 'acp', `会话应标着 acp：${viaAcp.thread.harness}`)
  const acpTurn = await runTurn(client, viaAcp.thread.id, '你好，ACP')
  expect(
    acpTurn.turn.status === 'completed',
    `acp 的回合没有正常结束：${JSON.stringify(acpTurn.turn)}`,
  )
  expect(
    replyOf(acpTurn.items).startsWith('acp 收到：你好，ACP'),
    `acp 的回话不对：${replyOf(acpTurn.items)}`,
  )
  const again = await client.call('thread/list', { limit: 50 })
  expect(
    again.data.some((thread) => thread.id === viaAcp.thread.id && thread.harness === 'acp'),
    'acp 的会话不在会话列表里',
  )
  passed('acp（opencode acp）新建会话并跑完一个回合，回话对得上，会话列表里有它')
  await checkHarnessConfig(client, fixtureInfo.root)
  client.close()
  return fixtureInfo.root
}

// 详情设置经聚合面转给 OpenCode 引擎：读写的是夹具里 OpenCode 自己的配置和凭据
async function checkHarnessConfig(client, fixtureRoot) {
  const H = { harness: 'opencode' }
  let read
  try {
    read = await client.call('litch/harness/config/read', H)
  } catch (error) {
    if (/-32601|不支持|not found|unknown method/i.test(error.message)) {
      console.log(`- 跳过详情设置：设备进程还不转 litch/harness/*（${error.message}）`)
      return
    }
    throw error
  }
  const model = read.settings.find((entry) => entry.key === 'model')
  expect(model?.options?.length > 0, `默认模型应当列出可选的模型：${JSON.stringify(model)}`)
  const settingsFile = read.files.find((file) => file.role === 'settings')?.path ?? ''
  expect(settingsFile.startsWith(fixtureRoot), `配置文件应当在夹具目录里：${settingsFile}`)
  const written = await client.call('litch/harness/config/write', {
    ...H,
    expectedVersion: read.version,
    edits: [{ key: 'share', value: 'manual' }],
  })
  const reread = await client.call('litch/harness/config/read', H)
  expect(reread.version === written.version, '写完读回来的版本号应当一样')
  expect(reread.values.share === 'manual', `share 应当是 manual：${reread.values.share}`)
  const providers = await client.call('litch/harness/providers/read', H)
  const anthropic = providers.providers.find((entry) => entry.id === 'anthropic')
  const method = anthropic?.methods.find((entry) => entry.kind === 'apiKey')
  expect(method, 'anthropic 应当能填 API key')
  const login = await client.call('litch/harness/auth/start', {
    ...H,
    providerId: 'anthropic',
    methodId: method.id,
    inputs: { key: 'sk-ant-fake-not-a-real-key-0000' },
  })
  expect(login.step.kind === 'done', `填 key 应当直接成功：${JSON.stringify(login.step)}`)
  await client.call('litch/harness/auth/logout', { ...H, providerId: 'anthropic' })
  const instructions = await client.call('litch/harness/instructions/read', H)
  expect(
    instructions.path.startsWith(fixtureRoot),
    `指令文件应当在夹具目录里：${instructions.path}`,
  )
  passed('详情设置：配置项读写、假 key 连上再断开、指令文件，都落在夹具目录里')
}

let failure = null
let root = null
try {
  root = await main()
} catch (error) {
  failure = error
}
if (!root) root = (await ready.catch(() => null))?.root ?? null
await stopFixture()
if (failure) {
  console.error(`✖ ${failure.message}`)
  console.error(`\n夹具的输出（末尾）：\n${fixtureOutput.split('\n').slice(-40).join('\n')}`)
}
// 夹具收场之后还留着的进程：有就是没收干净
await pause(300)
const left = root ? leftovers(root) : []
for (const pid of left) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经退出了
  }
}
if (left.length > 0) {
  console.error(`✖ 夹具退出之后还留着 ${left.length} 个进程（已强杀）：${left.join('、')}`)
  process.exit(1)
}
if (root && existsSync(root)) {
  // 夹具被强杀时来不及删：这里删掉，照样算没过
  rmSync(root, { recursive: true, force: true })
  console.error(`✖ 夹具没有删掉自己的临时目录（已删）：${root}`)
  process.exit(1)
}
if (failure) process.exit(1)
console.log(
  '检查通过：模型只配了回环上的假模型，往外的连接指到连不通的回环端口；没有留下进程和临时目录。',
)
