// 别的连接开的回合，正看着这个会话的连接要实时收到那条用户消息（userMessage 的 item/started、item/completed），
// 不必等重载（thread/read）才出来。和上游 codex 一样：谁开的回合都发给这个会话的全部订阅者，条目上带 clientId，
// 发起方靠它认出这是自己先显示出来的那一条。
//
// 对着 scripts/device-fixture.mjs --managed --engines … 起的隔离设备（提醒收尾开着），每家各走一遍：
//   A、B 两条 Litch 客户端连接，A 建会话（带 litch_sessions），B 用 thread/resume 订阅；
//   1. A 发一个回合（带 clientUserMessageId）：A、B 都实时收到这条用户消息，clientId 对得上，条目号只有一个；
//   2. 这一回合没调 wrap_up：设备进程用自己的连接开 kind=remind 的回合，A、B 都实时收到那条带
//      <litch-session-event kind="remind"> 的用户消息；
//   3. 支持插话的几家（ACP 没有插话；原生 codex 的假模型不会慢慢说，跳过）：A 发一个慢慢说的回合、中途插一句，
//      B 实时收到插的那句，clientId 对得上。
//
// 用法：node scripts/check-live-user-message.mjs [--engines claude,pi,dsh,opencode,acp,codex]
//   先 npm run build；本机要有 go。各家的隔离命令行用环境变量给（不会去 PATH 里找）：
//   CHA_CLAUDE_CLI、CHA_DSH_CLI、CHA_OPENCODE_CLI（acp 也用它，即 opencode acp）、CHA_CODEX_CLI。
//   隔离的做法在 device-fixture.mjs、client-fixture-engines.mjs 开头：模型是回环上的假模型，不碰 ~/.claude、~/.codex、~/.dsh。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const ALL = ['claude', 'pi', 'dsh', 'opencode', 'acp', 'codex']
const HARNESS = {
  claude: 'claude-code',
  pi: 'pi',
  dsh: 'dsh',
  opencode: 'opencode',
  acp: 'acp',
  codex: 'codex',
}
/** 走插话那一步的几家 */
const STEERS = new Set(['claude', 'pi', 'dsh', 'opencode'])

const at = process.argv.indexOf('--engines')
const engines = at < 0 ? ALL : (process.argv[at + 1] ?? '').split(',').filter(Boolean)
const unknown = engines.filter((name) => !ALL.includes(name))
if (unknown.length > 0 || engines.length === 0) {
  console.error(`--engines 后面写要走的几家，用逗号隔开（${ALL.join('、')}）${unknown.join(' ')}`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('跳过：夹具还不支持 Windows。')
  process.exit(0)
}
const sessionsModule = join(repo, 'packages/device/dist/protocol/src/client-tools-sessions.mjs')
if (!existsSync(sessionsModule)) {
  console.error('没有找到 packages/device 的构建产物，请先运行 npm run build')
  process.exit(1)
}
if (spawnSync('go', ['version']).status !== 0) {
  console.error('本机没有 go：夹具要现编适配器主进程')
  process.exit(1)
}
const { SESSION_TOOLS } = await import(sessionsModule)

// ---------- 起夹具 ----------
const fixtureEnv = { ...process.env, LITCH_FIXTURE_WRAP_UP_REMINDER: '1' }
if (engines.includes('acp')) {
  fixtureEnv.CHA_ACP_CLI = process.env.CHA_ACP_CLI ?? process.env.CHA_OPENCODE_CLI ?? ''
  fixtureEnv.CHA_ACP_ARGS = process.env.CHA_ACP_ARGS ?? 'acp'
}
const fixture = spawn(
  process.execPath,
  [
    join(repo, 'scripts/device-fixture.mjs'),
    '--managed',
    '--engines',
    engines.filter((name) => name !== 'pi').join(',') || 'pi',
  ],
  { cwd: repo, env: fixtureEnv, stdio: ['ignore', 'pipe', 'pipe'] },
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

/** 结束夹具：它自己停掉主进程（主进程再收掉各运行时）并删临时目录 */
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
  const client = {
    incoming,
    call(method, params) {
      const id = nextId++
      return new Promise((done, fail) => {
        pending.set(id, { done, fail, method })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    notify: (method) => ws.send(JSON.stringify({ method })),
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
  // 和 Litch 客户端一样声明会话树：设备进程才会把 litch_sessions 的调用当成自己的、提醒收尾
  await client.call('initialize', {
    clientInfo: { name: 'litch-check-live-user-message', title: null, version: '0.0.1' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      litchExtensions: ['harness', 'deviceWorkspaces', 'sessionTree', 'clientTools'],
      litchClientTools: { namespaces: [] },
    },
  })
  client.notify('initialized')
  return client
}

// ---------- 检查 ----------
const expect = (condition, what) => {
  if (!condition) throw new Error(`不符合预期：${what}`)
}
const passed = (line) => console.log(`✔ ${line}`)
const text = (value) => [{ type: 'text', text: value, text_elements: [] }]
const REMIND = '<litch-session-event kind="remind">'

const textOf = (item) =>
  (item.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')

/** 这条连接从 from 起收到的、这个会话的用户消息条目通知 */
const userFrames = (client, threadId, from) =>
  client.incoming
    .slice(from)
    .filter(
      (frame) =>
        (frame.method === 'item/started' || frame.method === 'item/completed') &&
        frame.params?.threadId === threadId &&
        frame.params.item?.type === 'userMessage',
    )

/**
 * 等这条连接实时收到一条用户消息：开始、完成各一次，条目号一样；符合 match 的只有这一个条目号（没有多出一条）。
 * 返回完成的那一帧
 */
async function liveUser(client, who, threadId, from, match, what) {
  const fits = (frame) =>
    (frame.method === 'item/started' || frame.method === 'item/completed') &&
    frame.params?.threadId === threadId &&
    frame.params.item?.type === 'userMessage' &&
    match(frame.params.item)
  const started = await client.waitFor(
    `${who} 收到${what}的 item/started`,
    (frame) => frame.method === 'item/started' && fits(frame),
    from,
  )
  const completed = await client.waitFor(
    `${who} 收到${what}的 item/completed`,
    (frame) => frame.method === 'item/completed' && fits(frame),
    from,
  )
  expect(
    started.params.item.id === completed.params.item.id,
    `${who} 收到的${what}开始、完成不是同一个条目：${started.params.item.id}、${completed.params.item.id}`,
  )
  expect(
    started.params.turnId === completed.params.turnId,
    `${who} 收到的${what}开始、完成不在同一个回合`,
  )
  return completed
}

/** 等这条连接收到这个回合的 turn/completed */
const turnDone = (client, who, threadId, turnId, from) =>
  client.waitFor(
    `${who} 收到回合 ${turnId} 的 turn/completed`,
    (frame) =>
      frame.method === 'turn/completed' &&
      frame.params?.threadId === threadId &&
      frame.params.turn?.id === turnId,
    from,
    120_000,
  )

/** 从 from 起符合 match 的用户消息只有一个条目号 */
function single(client, who, threadId, from, match, what) {
  const ids = new Set(
    userFrames(client, threadId, from)
      .filter((frame) => match(frame.params.item))
      .map((frame) => frame.params.item.id),
  )
  expect(ids.size === 1, `${who} 收到的${what}不止一条：${[...ids].join('、')}`)
}

/** 等设备进程开的提醒回合：A、B 都实时收到带 event 的那条用户消息，等它结束 */
async function remindSeen(name, a, b, threadId, fromA, fromB) {
  const isRemind = (item) => textOf(item).includes(REMIND)
  const onB = await liveUser(b, 'B', threadId, fromB, isRemind, '提醒收尾的用户消息')
  const onA = await liveUser(a, 'A', threadId, fromA, isRemind, '提醒收尾的用户消息')
  const turnId = onB.params.turnId
  expect(onA.params.turnId === turnId, `${name}：A、B 收到的提醒不在同一个回合`)
  await turnDone(b, 'B', threadId, turnId, fromB)
  single(b, 'B', threadId, fromB, isRemind, '提醒收尾的用户消息')
  single(a, 'A', threadId, fromA, isRemind, '提醒收尾的用户消息')
  return turnId
}

async function checkHarness(name, a, b, cwd) {
  const harness = HARNESS[name]
  const started = await a.call('thread/start', {
    harness,
    cwd,
    dynamicTools: [SESSION_TOOLS],
  })
  const threadId = started.thread.id
  // 原生 codex 的会话第一回合之前还没有记录，恢复不了（“no rollout found”）：先跑一回合（连同它的提醒回合）再订阅
  await b.call('thread/resume', { threadId }).catch(async (error) => {
    if (!/no rollout found/.test(error.message)) throw error
    const fromA = a.incoming.length
    const first = await a.call('turn/start', { threadId, input: text('先说一句') })
    await turnDone(a, 'A', threadId, first.turn.id, fromA)
    const remind = await a.waitFor(
      `${name} 头一回合之后的提醒回合结束`,
      (frame) =>
        frame.method === 'turn/completed' &&
        frame.params?.threadId === threadId &&
        frame.params.turn?.id !== first.turn.id,
      fromA,
      120_000,
    )
    expect(remind, '没有提醒回合')
    await b.call('thread/resume', { threadId })
  })

  // 1. A 发的话，B 实时看到；A 自己也收到，clientId 对得上
  let fromA = a.incoming.length
  let fromB = b.incoming.length
  const said = `你好，${name}`
  const clientId = `live-${name}-1`
  const own = (item) => item.clientId === clientId
  const turn = await a.call('turn/start', {
    threadId,
    input: text(said),
    clientUserMessageId: clientId,
  })
  const onB = await liveUser(b, 'B', threadId, fromB, own, 'A 发的那句')
  await liveUser(a, 'A', threadId, fromA, own, '自己发的那句')
  expect(onB.params.turnId === turn.turn.id, `${name}：B 收到的那句不在 A 开的回合里`)
  expect(textOf(onB.params.item) === said, `${name}：B 收到的话不对：${textOf(onB.params.item)}`)
  await turnDone(b, 'B', threadId, turn.turn.id, fromB)
  single(b, 'B', threadId, fromB, own, 'A 发的那句')
  single(a, 'A', threadId, fromA, own, '自己发的那句')
  passed(`${name}：A 发的话 B 实时收到（clientId 对得上，开始、完成各一次，只有一条）`)

  // 2. 这一回合没调 wrap_up：设备进程开提醒回合
  await remindSeen(name, a, b, threadId, fromA, fromB)
  passed(`${name}：设备进程开的提醒回合，A、B 都实时收到带 event 的用户消息`)

  if (!STEERS.has(name)) return
  // 3. 插话：A 在慢慢说的回合里插一句，B 实时看到
  fromA = a.incoming.length
  fromB = b.incoming.length
  const slow = await a.call('turn/start', {
    threadId,
    input: text('慢慢说'),
    clientUserMessageId: `live-${name}-slow`,
  })
  const slowId = slow.turn.id
  await a.waitFor(
    `${name} 慢慢说的回合开始出字`,
    (frame) => frame.method === 'item/agentMessage/delta' && frame.params?.threadId === threadId,
    fromA,
  )
  const steerId = `live-${name}-steer`
  const steered = (item) => item.clientId === steerId
  await a.call('turn/steer', {
    threadId,
    expectedTurnId: slowId,
    input: text('插一句'),
    clientUserMessageId: steerId,
  })
  const steerOnB = await liveUser(b, 'B', threadId, fromB, steered, 'A 插的那句')
  await liveUser(a, 'A', threadId, fromA, steered, '自己插的那句')
  expect(steerOnB.params.turnId === slowId, `${name}：B 收到的插话不在那个回合里`)
  expect(textOf(steerOnB.params.item) === '插一句', `${name}：插话的内容不对`)
  await turnDone(b, 'B', threadId, slowId, fromB)
  single(b, 'B', threadId, fromB, steered, 'A 插的那句')
  single(a, 'A', threadId, fromA, steered, '自己插的那句')
  passed(`${name}：A 插的话 B 实时收到（clientId 对得上，只有一条）`)
  // 这一回合也没调 wrap_up：等提醒回合跑完再走，免得收场时还有回合在跑
  await remindSeen(name, a, b, threadId, fromA, fromB)
}

async function main() {
  const fixtureInfo = await ready
  const cwd = fixtureInfo.engines.cwd
  const a = await connect(fixtureInfo.socket)
  const b = await connect(fixtureInfo.socket)
  const { harnesses } = await a.call('runtime/info')
  for (const name of engines) {
    const info = harnesses.find((item) => item.id === HARNESS[name])
    expect(
      info?.available === true,
      `${name} 应该可用：${JSON.stringify(info?.unavailable ?? info)}`,
    )
  }
  const failures = []
  for (const name of engines) {
    try {
      await checkHarness(name, a, b, cwd)
    } catch (error) {
      console.error(`✖ ${name}：${error.message}`)
      failures.push(name)
    }
  }
  a.close()
  b.close()
  if (failures.length) throw new Error(`没过的：${failures.join('、')}`)
  return fixtureInfo.root
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
console.log('检查通过：模型只配了回环上的假模型；没有留下进程和临时目录。')
