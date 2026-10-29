// 只测真实 Pi 历史探测：原生 SessionManager 造历史，直接启动隔离适配器，不调用模型、不运行电源后端。
// node scripts/bench-keep-awake.mjs；保留 .local 下的夹具与 JSON，冷样本指空适配器索引，不清系统页缓存。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { cpus, loadavg, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkRoot = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'))
const sdkEntry = join(sdkRoot, sdkPackage.main)

// 在子进程导入 SDK 前就设隔离 HOME，避免 SDK 顶层读取用户配置。
if (process.argv[2] === '--seed') {
  const [work, directory, countText, messagesText] = process.argv.slice(3)
  const count = Number(countText)
  const messages = Number(messagesText)
  const { SessionManager } = await import(pathToFileURL(sdkEntry).href)
  const files = []
  const began = performance.now()
  for (let index = 0; index < count; index++) {
    const manager = SessionManager.create(work, directory)
    for (let message = 0; message < messages; message++) {
      const timestamp = Date.now() + message
      if (message % 2 === 0)
        manager.appendMessage({
          role: 'user',
          content: `基准会话 ${index} 消息 ${message}：只用于真实历史索引成本测量。`,
          timestamp,
        })
      else
        manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `历史回答 ${index}/${message}，这不是模型生成请求。` }],
          api: 'openai-completions',
          provider: 'mock',
          model: 'fixture',
          stopReason: 'stop',
          timestamp,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        })
    }
    const file = manager.getSessionFile()
    assert.ok(file && existsSync(file))
    files.push({ id: manager.getSessionId(), bytes: statSync(file).size })
  }
  process.stdout.write(JSON.stringify({ generatedMs: performance.now() - began, files }))
  process.exit(0)
}

mkdirSync(join(repo, '.local'), { recursive: true })
const root = mkdtempSync(join(repo, '.local/kab-'))
const commonHome = join(root, 'build-home')
mkdirSync(commonHome)
const baseEnv = {
  PATH: process.env.PATH ?? '',
  HOME: commonHome,
  LANG: 'en_US.UTF-8',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
}
for (const prefix of ['packages/pi', 'packages/device']) {
  const build = spawnSync('npm', ['run', 'build', '--prefix', prefix], {
    cwd: repo,
    env: baseEnv,
    encoding: 'utf8',
  })
  if (build.status !== 0) throw new Error(`构建失败：${build.stdout}\n${build.stderr}`)
}
const { probePower } = await import(
  pathToFileURL(join(repo, 'packages/device/dist/device/src/power-probe.mjs')).href
)
const { unixConnector } = await import(
  pathToFileURL(join(repo, 'packages/device/dist/device/src/sockets.mjs')).href
)
const adapter = join(repo, 'packages/pi/dist/pi/src/adapter.mjs')
const resultFile = join(repo, '.local/keep-awake-probe-bench.json')
const results = {
  phase: '事件驱动+启动恢复+仅已知来源周期核对',
  baselineFile: '.local/keep-awake-probe-bench-before.json',
  at: new Date().toISOString(),
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  loadBefore: loadavg(),
  piVersion: sdkPackage.version,
  fixture: root,
  methodology: {
    transport: '真实Pi适配器进程，通过Unix socket WebSocket调用当前probePower，无fake协议或模型',
    cold: '每次全新适配器进程与空SQLite索引；原生JSONL由SessionManager生成；OS文件页缓存未清',
    warm: '同一进程、相同历史、紧接冷样本的两次probe',
    scope:
      '没有活跃/loaded会话；恢复与周期空集合不应随历史增长。另测一个已知已结束来源；不外推其他引擎。所有历史在样本后额外全分页核验，核验不计入probe耗时。',
    timeoutMs: 10000,
  },
  cases: [],
}
const save = () => writeFileSync(resultFile, `${JSON.stringify(results, null, 2)}\n`)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

async function ready(socket, child) {
  const deadline = performance.now() + 15000
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Pi入口提前退出 ${child.exitCode}`)
    const okay = await new Promise((done) => {
      const connection = net.createConnection(socket)
      connection.once('connect', () => {
        connection.destroy()
        done(true)
      })
      connection.once('error', () => done(false))
    })
    if (okay) return
    await wait(25)
  }
  throw new Error('Pi入口就绪超时')
}

async function sample(socket, expected, temperature, knownId) {
  const requests = new Map()
  const methods = {}
  const listed = new Set()
  let listRows = 0
  const rawConnect = unixConnector(socket)
  const connect = async (handlers) => {
    const wire = await rawConnect({
      close: (reason) => handlers.close(reason),
      message(raw) {
        const frame = JSON.parse(raw)
        const request = requests.get(frame.id)
        if (request) {
          requests.delete(frame.id)
          const took = performance.now() - request.started
          const method = methods[request.method]
          method.responseMs.push(took)
          if (frame.error) method.errors++
          if (request.method === 'thread/list' && Array.isArray(frame.result?.data)) {
            listRows += frame.result.data.length
            for (const row of frame.result.data) listed.add(row.id)
            method.pageRows.push(frame.result.data.length)
          }
        }
        handlers.message(raw)
      },
    })
    return {
      close: () => wire.close(),
      send(raw) {
        const frame = JSON.parse(raw)
        if (frame.id !== undefined) {
          assert.ok(
            [
              'initialize',
              'runtime/info',
              'thread/list',
              'thread/loaded/list',
              'thread/read',
              'thread/backgroundTerminals/list',
              'litch/internal/power/activity',
            ].includes(frame.method),
          )
          const method = (methods[frame.method] ??= {
            requests: 0,
            errors: 0,
            responseMs: [],
            pageRows: [],
          })
          method.requests++
          requests.set(frame.id, { method: frame.method, started: performance.now() })
        }
        wire.send(raw)
      },
    }
  }
  const began = performance.now()
  let outcome
  try {
    const snapshot = await probePower(
      { id: 'pi', running: true, connect },
      {
        signal: new AbortController().signal,
        timeoutMs: 10000,
        version: 'keep-awake-bench',
        mode: temperature.startsWith('periodic') ? 'known' : 'recover',
        knownThreads: temperature === 'periodic-known-ended' ? [knownId] : [],
      },
    )
    outcome = {
      success: true,
      complete: snapshot.complete,
      active: snapshot.active.size,
      backgrounds: [...snapshot.background.values()].filter(Boolean).length,
    }
  } catch (error) {
    outcome = { success: false, error: String(error) }
  }
  const wallMs = performance.now() - began
  const measured = {
    temperature,
    wallMs,
    ...outcome,
    listRows,
    uniqueListed: listed.size,
    expected,
    globalHistoryQueries: methods['thread/list']?.requests ?? 0,
    methods,
    load: loadavg(),
  }
  assert.equal(measured.globalHistoryQueries, 0, '新probe不允许扫描历史')
  return measured
}

// 历史完整性验证单独计时，防止把“没有历史”误当作新探针的性能收益。
async function verifyHistory(socket, count) {
  let sequence = 0
  const pending = new Map()
  const wire = await unixConnector(socket)({
    close() {},
    message(raw) {
      const frame = JSON.parse(raw)
      const waiter = pending.get(frame.id)
      if (waiter) {
        pending.delete(frame.id)
        frame.error
          ? waiter.reject(new Error(JSON.stringify(frame.error)))
          : waiter.resolve(frame.result)
      }
    },
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      wire.send(JSON.stringify({ id, method, params }))
    })
  const began = performance.now()
  try {
    await call('initialize', {
      clientInfo: { name: 'keep-awake-bench-validator', version: 'test' },
      capabilities: { experimentalApi: true },
    })
    wire.send(JSON.stringify({ method: 'initialized' }))
    const seen = new Set()
    let cursor
    let pages = 0
    do {
      const page = await call('thread/list', {
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        ...(cursor ? { cursor } : {}),
      })
      for (const row of page.data) seen.add(row.id)
      pages++
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(seen.size, count)
    return { rows: seen.size, pages, wallMs: performance.now() - began }
  } finally {
    wire.close()
  }
}

for (const [count, messages] of [
  [100, 2],
  [1000, 2],
  [1000, 40],
]) {
  const label = `${count}x${messages}`
  const directory = join(root, label)
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const agent = join(directory, 'agent')
  const sessions = join(agent, 'sessions')
  for (const path of [home, work, sessions]) mkdirSync(path, { recursive: true })
  const env = {
    ...baseEnv,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_CLI: join(dirname(sdkEntry), 'cli.js'),
    CHA_BACKGROUND_SHELL: 'off',
  }
  const seeded = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--seed', work, sessions, String(count), String(messages)],
    { cwd: work, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  )
  if (seeded.status !== 0) throw new Error(`生成真实历史失败：${seeded.stderr}`)
  const seed = JSON.parse(seeded.stdout)
  const row = {
    count,
    messagesPerSession: messages,
    generatedMs: seed.generatedMs,
    historyBytes: seed.files.reduce((sum, file) => sum + file.bytes, 0),
    samples: [],
  }
  results.cases.push(row)
  save()
  for (let round = 0; round < 2; round++) {
    const state = join(directory, `state-${round}`)
    mkdirSync(state)
    const socket = join(root, 'p.sock')
    let stderr = ''
    const child = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${socket}`], {
      cwd: work,
      env: { ...env, CHA_PI_HOME: state },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    const exited = new Promise((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    )
    try {
      await ready(socket, child)
      for (const temperature of [
        'cold',
        'warm-1',
        'warm-2',
        'periodic-empty',
        'periodic-known-ended',
      ]) {
        const measured = await sample(socket, count, temperature, seed.files[0].id)
        row.samples.push({ round, ...measured })
        save()
        console.log(
          `${label} round=${round} ${temperature}: ${measured.wallMs.toFixed(1)}ms rows=${measured.uniqueListed}/${count} success=${measured.success}`,
        )
      }
      row.samples.push({ round, validationOnly: await verifyHistory(socket, count) })
      save()
    } finally {
      child.kill('SIGTERM')
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(killer)
      writeFileSync(join(state, 'stderr.log'), stderr)
    }
  }
}
results.loadAfter = loadavg()
save()
console.log(`结果：${resultFile}`)
