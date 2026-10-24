// 对着这台机器上真的 codex 检查“直连原生 codex 时开发者指令由核心补齐”（packages/core/src/device/codex-instructions.mts）：
// 中间没有设备进程，codex 自己不认命名空间上的规则（悄悄丢掉），也不保存开发者指令。这里用核心的那一份补法，
// 直接对 codex app-server（stdio）走一遍：建会话（带一个有规则的命名空间）→ 回合 → 重启 codex → 恢复 → 压缩 → 回合；
// 再分叉 → 压缩 → 回合。每次模型请求里，规则和 config.toml 那段都要在、各 1 次。
// 对照：不经核心补法、原样带着命名空间建的会话，规则一次都到不了模型（这就是没补时直连的样子）。
// 模型是回环上的假 Responses 接口。
//
// 用法：node scripts/check-codex-direct-instructions.mjs（先 npm run build --prefix packages/core）
//   CHA_CODEX_CLI 指定用哪一份 codex；没给时用 PATH 里的，PATH 里也没有就说明原因后跳过（退出码 0）。
// 隔离同 check-native-codex-instructions.mjs：HOME、CODEX_HOME、TMPDIR 在临时目录里，环境从零写，代理指到没人听的端口，
// 不碰 ~/.codex；结束时收掉自己起的进程、删掉临时目录。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  codexConfig,
  findCodex,
  startResponsesModel,
  userText,
} from './client-fixture-responses.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(repo, 'packages/core/dist/packages/core/src/device/codex-instructions.mjs')

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
if (!existsSync(built)) {
  console.error('没有找到核心的构建产物，请先运行 npm run build --prefix packages/core')
  process.exit(1)
}
const { createDirectInstructions } = await import(built)

const root = mkdtempSync('/tmp/lcd-')
const dirs = {
  userHome: join(root, 'h'),
  codexHome: join(root, 'c'),
  tmp: join(root, 't'),
  work: join(root, 'w'),
}
for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true })

const RULES_MARK = 'DIRECT_RULES_MARK_9Z'
const CONFIG_MARK = 'CFG_MARK_7Q'
/** 一个带规则的命名空间（真的命名空间里现在只有设备进程执行的 litch_sessions 带规则，直连时不带它） */
const RULED = {
  type: 'namespace',
  name: 'litch_ruled',
  description: 'Litch check tools.',
  instructions: `Always follow the ruled-namespace rules. ${RULES_MARK}`,
  tools: [
    {
      type: 'function',
      name: 'echo',
      description: 'Return the given text unchanged.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ],
}

const seen = []
const count = (haystack, needle) => haystack.split(needle).length - 1
const model = await startResponsesModel((body) => {
  const input = JSON.stringify(body.input ?? [])
  const said = userText(body)
  const compaction = said.includes('CONTEXT CHECKPOINT COMPACTION')
  seen.push({
    said: compaction ? '（压缩）' : said,
    rules: count(input, RULES_MARK),
    config: count(input, CONFIG_MARK),
  })
  return { text: compaction ? 'SUMMARY_OF_CONVERSATION' : `假模型收到：${said}` }
})
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
}

/** 一个 codex app-server（stdio），和核心的补法接在一起：thread/start、resume、fork 都先过 prepare */
function startCodex(direct) {
  const child = spawn(codex, ['app-server'], {
    env: isolated,
    cwd: dirs.work,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const pending = new Map()
  const waiters = new Set()
  let nextId = 0
  child.once('exit', (code) => {
    for (const { fail } of pending.values())
      fail(new Error(`codex 退出了（${code}）：${stderr.slice(-2000)}`))
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.id != null && pending.has(frame.id)) {
      const { done, fail } = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) fail(new Error(JSON.stringify(frame.error)))
      else done(frame.result)
      return
    }
    // 这里的回合不调工具、不要审批；真来了一律拒
    if (frame.id != null && frame.method) {
      child.stdin.write(`${JSON.stringify({ id: frame.id, result: { decision: 'decline' } })}\n`)
      return
    }
    for (const waiter of [...waiters]) if (waiter(frame)) waiters.delete(waiter)
  })
  const raw = (method, params) =>
    new Promise((done, fail) => {
      const id = ++nextId
      pending.set(id, { done, fail })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  const waitFor = (what, predicate, timeoutMs = 60_000) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        fail(new Error(`等了 ${timeoutMs / 1000} 秒没有等到：${what}\n${stderr.slice(-2000)}`))
      }, timeoutMs)
      const waiter = (frame) => {
        if (!predicate(frame)) return false
        clearTimeout(timer)
        done(frame)
        return true
      }
      waiters.add(waiter)
    })
  const helper = direct(raw)
  return {
    raw,
    /** 照核心的做法：先补，再发，应答回来记下 */
    async call(method, params) {
      const prepared = helper.prepare(method, params)
      if (!prepared) return raw(method, params)
      const { params: ready, remember } = await prepared
      const result = await raw(method, ready)
      remember(result)
      return result
    },
    async init() {
      await raw('initialize', {
        clientInfo: { name: 'litch-check', title: null, version: '0.0.1' },
        capabilities: { experimentalApi: true },
      })
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    },
    async turn(threadId, said) {
      const done = waitFor(
        `回合结束（${said}）`,
        (frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId,
      )
      await raw('turn/start', {
        threadId,
        input: [{ type: 'text', text: said, text_elements: [] }],
      })
      const frame = await done
      if (frame.params.turn.status !== 'completed')
        throw new Error(`回合没正常结束：${JSON.stringify(frame.params.turn)}`)
    },
    async compact(threadId) {
      const before = seen.length
      const done = waitFor(
        '压缩结束',
        (frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId,
      )
      await raw('thread/compact/start', { threadId })
      await done
      if (!seen.slice(before).some((entry) => entry.said === '（压缩）'))
        throw new Error('压缩时应该向模型要一段摘要')
    },
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise((done) => {
        child.once('exit', done)
        child.kill('SIGTERM')
      })
    },
  }
}

const expect = (condition, what) => {
  if (!condition) throw new Error(`不符合预期：${what}`)
}
const passed = (line) => console.log(`✔ ${line}`)

/** 这一步之后的模型请求（压缩那次不算）：规则、config.toml 那段各几次 */
function each(from, what, rules, config) {
  const asked = seen.slice(from).filter((entry) => entry.said !== '（压缩）')
  expect(asked.length > 0, `${what}：没有模型请求`)
  for (const entry of asked)
    expect(
      entry.rules === rules && entry.config === config,
      `${what}：请求「${entry.said}」里规则 ${entry.rules} 次、config.toml 那段 ${entry.config} 次，应是 ${rules}、${config}`,
    )
}

// 这台电脑上记的（外壳存成文件；这里留在内存里，跨“重启 codex”一直在）
let notes = null
const direct = (raw) =>
  createDirectInstructions({
    clock: {
      now: () => Date.now(),
      setTimer: (callback, ms) => clearTimeout.bind(null, setTimeout(callback, ms)),
    },
    store: { load: () => notes, save: (next) => (notes = structuredClone(next)) },
    ask: raw,
    specs: (names) => (names.includes(RULED.name) ? [RULED] : []),
    cwdOf: () => dirs.work,
    log: (line) => console.log(`  （核心）${line}`),
  })

let running = null
async function main() {
  const base = { cwd: dirs.work, approvalPolicy: 'never', sandbox: 'read-only' }
  running = startCodex(direct)
  await running.init()
  // 对照：原样带着命名空间建（没补），规则到不了模型
  const plain = (await running.raw('thread/start', { ...base, dynamicTools: [RULED] })).thread.id
  let from = seen.length
  await running.turn(plain, '对照：没补')
  each(from, '没补的会话', 0, 1)
  passed('对照：命名空间上的规则 codex 不认，没补时一次都到不了模型（只有 config.toml 那段）')

  const threadId = (await running.call('thread/start', { ...base, dynamicTools: [RULED] })).thread
    .id
  from = seen.length
  await running.turn(threadId, '第一回合')
  each(from, '建会话后的第一回合', 1, 1)
  passed('建会话：规则拼在 config.toml 那段后面，两段都在、各 1 次')

  await running.stop()
  running = startCodex(direct)
  await running.init()
  await running.call('thread/resume', { threadId })
  await running.compact(threadId)
  from = seen.length
  await running.turn(threadId, '压缩之后')
  await running.turn(threadId, '压缩之后再一回合')
  each(from, '重启、恢复、压缩之后', 1, 1)
  passed('重启 codex → 恢复（核心补上）→ 压缩 → 回合：两段都在、各 1 次，不叠加')

  const fork = (await running.call('thread/fork', { threadId })).thread.id
  await running.compact(fork)
  from = seen.length
  await running.turn(fork, '分叉压缩之后')
  each(from, '分叉、压缩之后', 1, 1)
  passed('分叉（核心补上）→ 压缩 → 回合：两段都在、各 1 次')
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
}
await running?.stop()
model.close()
rmSync(root, { recursive: true, force: true })
if (failure) {
  console.error(`✖ ${failure.message}`)
  console.error(
    `\n模型请求：\n${seen.map((entry, at) => `  ${at + 1} ${entry.said} 规则 ${entry.rules} config ${entry.config}`).join('\n')}`,
  )
  process.exit(1)
}
console.log(`检查通过：模型请求 ${model.requests()} 次，都打在回环上的假模型；没有留下临时文件。`)
