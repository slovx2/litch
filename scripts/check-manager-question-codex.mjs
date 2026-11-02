// 真 Codex + 回环假模型 + 真实设备处理器；仅控制面名单用夹具，测试结束不留记录。
// 先 build；CHA_CODEX_CLI 可指定隔离 CLI，不读真实 HOME/CODEX_HOME。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unixConnector } from '../packages/device/dist/device/src/sockets.mjs'
import { FakeControl, managed } from '../packages/device/dist/device/test/fake-control.mjs'
import { FakeEngine } from '../packages/device/dist/device/test/fake-engine.mjs'
import { rig } from '../packages/device/dist/device/test/helpers.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../packages/device/dist/protocol/src/manager.mjs'
import {
  codexConfig,
  codexSocketCleanup,
  findCodex,
  startResponsesModel,
  userText,
} from './client-fixture-responses.mjs'

const codex = findCodex()
assert.ok(codex, '需要 CHA_CODEX_CLI 或 PATH 上的 Codex')
const root = mkdtempSync('/tmp/lcq-')
const home = join(root, 'home')
const config = join(root, 'codex')
const work = join(root, 'work')
for (const dir of [home, config, work]) mkdirSync(dir)
let env
let child
let cleanSocket = () => {}
let output = ''
let managerId = ''
let outsideId = ''
let lineId = ''
const received = []
const operations = [
  ['list', {}],
  ['read', () => ({ thread_id: managerId })],
  ['read', () => ({ thread_id: lineId })],
  ['read', () => ({ thread_id: outsideId })],
  ['start', { title: 'forbidden' }],
  ['send', () => ({ thread_id: lineId, message: 'forbidden' })],
]
let index = 0
let active = false
let inherited = false
const model = await startResponsesModel((body) => {
  if (!userText(body).includes('QUESTION_READ_PROBE')) return { text: 'manager ready' }
  const namespace = body.tools?.find((tool) => tool.name === 'litch_sessions')
  inherited ||= namespace?.tools?.some((tool) => tool.name === 'start') === true
  const last = body.input?.at(-1)
  if (active && last?.type === 'function_call_output') received.push(last.output)
  active = true
  const operation = operations[index++]
  if (!operation) return { text: 'QUESTION_READ_DONE' }
  const [name, args] = operation
  return {
    call: {
      namespace: 'litch_sessions',
      name,
      arguments: JSON.stringify(typeof args === 'function' ? args() : args),
    },
  }
})
const wait = async (predicate, what) => {
  const deadline = Date.now() + 60_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`超时：${what}\n${output.slice(-2000)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
try {
  writeFileSync(join(config, 'config.toml'), codexConfig(model.baseUrl))
  const socket = join(root, 'codex.sock')
  child = spawn(codex, ['app-server', '--listen', `unix://${socket}`], {
    env: {
      HOME: home,
      CODEX_HOME: config,
      TMPDIR: root,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      output += data
    })
  await wait(() => existsSync(socket), 'Codex socket')
  cleanSocket = codexSocketCleanup(socket)
  const cross = new FakeEngine('pi')
  const control = new FakeControl([{ ...managed('codex'), native: true }, managed('pi')])
  env = rig(
    {},
    {},
    {
      stateDir: join(root, 'state'),
      control,
      dial: (address) => (address === 'fake://codex' ? unixConnector(socket) : cross.connector),
    },
  )
  const client = env.connect()
  await client.initialize(['harness', 'litchManager'])
  const created = await client.call(MANAGER_METHOD.create, {
    cwd: work,
    harness: 'codex',
    model: null,
    effort: null,
    name: '隔离经理',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
  })
  managerId = created.threadId
  const tree = env.device.sessionTree
  await wait(() => model.requests() > 0 && !tree.isActive(managerId), '经理首轮')
  const line = await client.call('thread/start', { harness: 'pi', cwd: work })
  lineId = line.thread.id
  tree.store.addLineage({
    threadId: lineId,
    parentThreadId: managerId,
    harness: 'pi',
    kind: 'fresh',
    origin: 'model',
    title: '跨引擎工作线',
    prompt: '',
    wakeParent: false,
    createdAt: 1,
    proposalId: '',
  })
  outsideId = (await client.call('thread/start', { harness: 'pi', cwd: work })).thread.id
  env.device.managers.writer.tool(created.manager.id, 'add', {
    kind: 'decision',
    decision: { title: '背景', background: '' },
  })
  await client.call(MANAGER_METHOD.questionAsk, {
    managerId: created.manager.id,
    decisionId: 'D-1',
    revision: 1,
    question: 'QUESTION_READ_PROBE',
  })
  await wait(() => {
    const entry = env.device.managers.store
      .question(created.manager.id, 'D-1')
      ?.discussion.messages.at(-1)
    if (entry?.status === 'failed') throw new Error(entry.answer)
    return entry?.status === 'completed'
  }, '临时问答')
  assert.equal(inherited, true, 'fork 继承父工具表，仍显示 start；必须由设备拒绝')
  assert.equal(received.length, operations.length)
  const strings = received.map((result) =>
    typeof result === 'string' ? result : JSON.stringify(result),
  )
  assert.match(strings[0], new RegExp(managerId))
  assert.match(strings[0], new RegExp(lineId))
  assert.ok(!strings[0].includes(outsideId))
  assert.match(strings[1], new RegExp(managerId))
  assert.match(strings[2], new RegExp(lineId))
  for (const result of strings.slice(3)) assert.match(result, /litch:blocked/)
  assert.equal(cross.seen.filter((call) => call.method === 'turn/start').length, 0)
  console.log(
    'PASS 真 Codex：继承工具、list、经理/跨引擎线 read；同 cwd 越权 read、start、send 拒绝',
  )
} finally {
  await env?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }
  cleanSocket()
  model.close()
  rmSync(root, { recursive: true, force: true })
}
