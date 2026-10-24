// 对着这台机器上真的 codex 检查“开发者指令经设备进程补齐”（packages/device/src/codex-instructions.mts）：
// codex 不保存 developerInstructions，会话重新装载过、恢复时没带、之后又压缩过一次，规则就没了；带了又会整段盖掉
// config.toml 的 developer_instructions。这里走一遍：建会话（带 litch_sessions，不给开发者指令）→ 回合 → 重启 codex →
// 恢复不带开发者指令 → 手动压缩 → 再发回合；再从这个会话分叉（不带）→ 分叉上压缩 → 回合。每次模型请求里，
// 建议任务的规则和 config.toml 那段都要在，而且各只出现 1 次。最后再建一个不带规则、客户端给了自己那段开发者指令的会话，
// 重启、恢复不带、压缩之后，客户端那段要在（各 1 次），config.toml 那段不在（客户端给的整段替换它，和建会话时一样）。
// 真的适配器主进程（Go，现编到临时目录里）+ 真的设备进程 + 真的 codex，模型是回环上的假 Responses 接口。
//
// 用法：node scripts/check-native-codex-instructions.mjs（先 npm run build --prefix packages/device；需要本机有 go）
//   CHA_CODEX_CLI 指定用哪一份 codex；没给时用 PATH 里的，PATH 里也没有就说明原因后跳过（退出码 0）。
// 隔离同 check-native-codex.mjs：HOME、CODEX_HOME、TMPDIR 在临时目录里，环境从零写，代理指到没人听的端口，
// 不碰 ~/.codex 和真实的适配器状态目录；结束时收掉自己起的进程、删掉临时目录。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import {
  codexConfig,
  codexSocketCleanup,
  findCodex,
  startResponsesModel,
  userText,
} from './client-fixture-responses.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

let codex = null
try {
  codex = findCodex()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
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
// 规则用设备进程构建产物里的那一份（和设备进程拼进去的是同一段）
const { SESSION_TOOLS, outsideLitch } = await import(
  join(repo, 'packages/device/dist/protocol/src/client-tools-sessions.mjs')
)

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync('/tmp/lci-')
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

// 认标记：规则的头一句（从构建产物里取，规则改写了也跟着变）、config.toml 那段里的记号
const RULES_MARK = SESSION_TOOLS.instructions.split('. ')[0]
const CONFIG_MARK = 'CFG_MARK_7Q'
// 客户端自己给的开发者指令里的记号（不带规则的会话用）
const GIVEN_MARK = 'GIVEN_MARK_4K'
// 规则末尾“不在 Litch 里就别再调 litch_*”的兜底：拿到官方桌面端分叉、接着用的会话靠它停手，要跟着规则一起到
const OUTSIDE_MARK = outsideLitch(true)

// ---------- 假模型：记下每次请求里两个标记各出现几次，压缩请求回一段摘要 ----------
const seen = []
const count = (haystack, needle) => haystack.split(needle).length - 1
const model = await startResponsesModel((body) => {
  const input = JSON.stringify(body.input ?? [])
  const said = userText(body)
  const compaction = said.includes('CONTEXT CHECKPOINT COMPACTION')
  seen.push({
    said: compaction ? '（压缩）' : said,
    rules: count(input, RULES_MARK),
    outside: count(input, JSON.stringify(OUTSIDE_MARK).slice(1, -1)),
    config: count(input, CONFIG_MARK),
    given: count(input, GIVEN_MARK),
  })
  return { text: compaction ? 'SUMMARY_OF_CONVERSATION' : `假模型收到：${said}` }
})
// developer_instructions 是顶层的键，要写在任何 [表] 之前
writeFileSync(
  join(dirs.codexHome, 'config.toml'),
  `developer_instructions = "config.toml 里的开发者指令 ${CONFIG_MARK}"\n${codexConfig(model.baseUrl)}`,
)

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
async function connect(path) {
  const ws = new WebSocket(`ws+unix://${path}:/`)
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
        pending.set(id, { done, fail })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    waitFor(what, predicate, from = 0, timeoutMs = 60_000) {
      const found = incoming.slice(from).find(predicate)
      if (found) return Promise.resolve(found)
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

// ---------- 主进程 ----------
const binary = join(root, 'cha')
const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
  cwd: repo,
  encoding: 'utf8',
})
let service = null
let output = ''
let removeCodexSocket = () => {}

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
const STATUS = 'litch/harness/status/changed'
const available = (frame) =>
  frame.method === STATUS &&
  frame.params.harness === 'codex' &&
  frame.params.info.available === true

/** 这一步之后的模型请求：规则（连同末尾的兜底）、config.toml 那段都各只有 1 次 */
function bothOnce(from, what) {
  const asked = seen.slice(from).filter((entry) => entry.said !== '（压缩）')
  expect(asked.length > 0, `${what}：没有模型请求`)
  for (const entry of asked)
    expect(
      entry.rules === 1 && entry.outside === 1 && entry.config === 1,
      `${what}：请求「${entry.said}」里规则 ${entry.rules} 次、兜底 ${entry.outside} 次、config.toml 那段 ${entry.config} 次，应各 1 次`,
    )
}

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
  const client = await connect(deviceSocket)
  await client.call('initialize', {
    clientInfo: { name: 'litch-check', title: null, version: '0.0.1' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      litchExtensions: ['harness', 'deviceSettings', 'clientTools'],
    },
  })
  // 打开 Codex；提醒收尾关掉（假模型不调 wrap_up，开着会多出提醒回合）
  const { snapshot } = await client.call('litch/device/settings/read')
  let mark = client.incoming.length
  const written = await client.call('litch/device/settings/write', {
    expectedVersion: snapshot.version,
    edits: [
      { key: 'harness.codex.enabled', value: true },
      { key: 'harness.codex.cliPath', value: codex },
      { key: 'sessions.wrapUpReminder', value: false },
    ],
  })
  if (!written.restarted.includes('codex'))
    await client.call('litch/device/harness/restart', { harness: 'codex', force: true })
  await client.waitFor('Codex 变成可用', available, mark)
  removeCodexSocket = codexSocketCleanup(runtimeSocket)

  const turn = async (threadId, said) => {
    const from = client.incoming.length
    await client.call('turn/start', { threadId, input: text(said) })
    const done = await client.waitFor(
      `回合结束（${said}）`,
      (frame) => frame.method === 'turn/completed' && frame.params.threadId === threadId,
      from,
    )
    expect(
      done.params.turn.status === 'completed',
      `回合没正常结束：${JSON.stringify(done.params.turn)}`,
    )
  }
  const compact = async (threadId) => {
    const from = client.incoming.length
    const before = seen.length
    await client.call('thread/compact/start', { threadId })
    await client.waitFor(
      '压缩结束',
      (frame) => frame.method === 'turn/completed' && frame.params.threadId === threadId,
      from,
    )
    expect(
      seen.slice(before).some((entry) => entry.said === '（压缩）'),
      '压缩时应该向模型要一段摘要',
    )
  }

  // 建会话：带 litch_sessions，不给开发者指令
  const started = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    permissions: ':workspace',
    dynamicTools: [SESSION_TOOLS],
  })
  const threadId = started.thread.id
  let from = seen.length
  await turn(threadId, '第一回合')
  bothOnce(from, '建会话后的第一回合')
  passed('建会话：规则拼在 config.toml 的开发者指令后面，两段都在、各 1 次')

  // 重启 codex：会话从磁盘重新装载
  mark = client.incoming.length
  await client.call('litch/device/harness/restart', { harness: 'codex', force: true })
  await client.waitFor('Codex 重启后可用', available, mark)
  await client.call('thread/resume', { threadId })
  from = seen.length
  await turn(threadId, '重启恢复后')
  bothOnce(from, '重启后恢复（不带开发者指令）')
  await compact(threadId)
  from = seen.length
  await turn(threadId, '压缩之后')
  await turn(threadId, '压缩之后再一回合')
  bothOnce(from, '重启、恢复、压缩之后')
  passed('重启 codex → 恢复不带开发者指令 → 压缩 → 回合：两段都在、各 1 次，不叠加')

  // 分叉（不带）→ 分叉上压缩 → 回合；再从分叉分叉一次
  const fork = (await client.call('thread/fork', { threadId })).thread.id
  await compact(fork)
  from = seen.length
  await turn(fork, '分叉压缩之后')
  bothOnce(from, '分叉、压缩之后')
  const again = (await client.call('thread/fork', { threadId: fork })).thread.id
  await compact(again)
  from = seen.length
  await turn(again, '分叉的分叉压缩之后')
  bothOnce(from, '分叉的分叉、压缩之后')
  passed('分叉、分叉的分叉不带开发者指令，压缩后两段都在、各 1 次')

  // 不带规则、客户端给了自己那段的会话：设备进程照样记下，重启、恢复不带、压缩之后补回
  const own = (
    await client.call('thread/start', {
      harness: 'codex',
      cwd: dirs.work,
      permissions: ':workspace',
      developerInstructions: `客户端自己的开发者指令 ${GIVEN_MARK}`,
    })
  ).thread.id
  const givenOnce = (start, what) => {
    const asked = seen.slice(start).filter((entry) => entry.said !== '（压缩）')
    expect(asked.length > 0, `${what}：没有模型请求`)
    for (const entry of asked)
      expect(
        entry.given === 1 && entry.config === 0 && entry.rules === 0,
        `${what}：请求「${entry.said}」里客户端那段 ${entry.given} 次、config.toml 那段 ${entry.config} 次、规则 ${entry.rules} 次，应是 1、0、0`,
      )
  }
  from = seen.length
  await turn(own, '自带指令的第一回合')
  givenOnce(from, '自带指令的会话建好后')
  mark = client.incoming.length
  await client.call('litch/device/harness/restart', { harness: 'codex', force: true })
  await client.waitFor('Codex 再次重启后可用', available, mark)
  await client.call('thread/resume', { threadId: own })
  await compact(own)
  from = seen.length
  await turn(own, '自带指令压缩之后')
  givenOnce(from, '自带指令的会话重启、恢复、压缩之后')
  passed(
    '不带规则、客户端给了开发者指令的会话：重启 → 恢复不带 → 压缩 → 回合，客户端那段还在、1 次',
  )
  client.close()
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
}
const tail = (value) => value.split('\n').slice(-40).join('\n')
if (failure) {
  console.error(`✖ ${failure.message}`)
  console.error(
    `\n模型请求（规则、config.toml 那段出现的次数）：\n${seen.map((entry, at) => `  ${at + 1} ${entry.said} 规则 ${entry.rules} config ${entry.config} 客户端 ${entry.given}`).join('\n')}`,
  )
  console.error(`\n主进程的输出（末尾）：\n${tail(output)}`)
  const runtimeLog = join(dirs.adapterHome, 'codex', 'runtime.log')
  if (existsSync(runtimeLog))
    console.error(`\ncodex 的运行日志（末尾）：\n${tail(readFileSync(runtimeLog, 'utf8'))}`)
}
await stopService()
await pause(300)
const left = leftovers()
model.close()
for (const pid of left) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经退出了
  }
}
removeCodexSocket()
rmSync(root, { recursive: true, force: true })
if (left.length > 0) {
  console.error(`✖ 主进程退出之后还留着 ${left.length} 个进程（已强杀）：${left.join('、')}`)
  process.exit(1)
}
if (failure) process.exit(1)
console.log(
  `检查通过：模型请求 ${model.requests()} 次，都打在回环上的假模型；没有留下进程和临时文件。`,
)
