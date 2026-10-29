// 经理脚本验收的进程与 RPC。环境采用白名单，HOME、CODEX_HOME 显式指进临时目录；不继承模型凭据。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url))

/** Go 自动下载的 toolchain 不受 -modcacherw 影响；只处理自建临时根里的目录，不跟随链接。 */
function writableDirectories(directory) {
  chmodSync(directory, 0o700)
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) writableDirectories(join(directory, entry.name))
}

/** 所有等待均有截止时间，失败消息包含最后一次实际读取的状态。 */
export async function until(what, read, fits, timeout = 90_000, pollMs = 100) {
  const deadline = Date.now() + timeout
  let value
  do {
    value = await read()
    if (fits(value)) return value
    await pause(pollMs)
  } while (Date.now() < deadline)
  throw new Error(`等待超时：${what}；最后状态：${JSON.stringify(value)}`)
}

const itemText = (item) =>
  item.type === 'agentMessage'
    ? item.text
    : (item.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')

/**
 * Codex 收尾时 thread/read 可能短暂返回 interrupted、completedAt=null，随后同一回合变成 completed。
 * 不能把一次读快照的“非 inProgress”当终态，也不能用 thread.status=idle 判断回合已持久化。
 * 真正的失败/中断通知立即报错；缺通知的旧回合须读到 completed，否则由调用方限时等待失败。
 */
export function completedManagerTurn(thread, frames, threadId, eventKind, turnId) {
  const turn = thread.turns?.find((entry) =>
    turnId
      ? entry.id === turnId
      : entry.items.some(
          (item) => item.type === 'userMessage' && itemText(item).includes(`kind="${eventKind}"`),
        ),
  )
  if (!turn) return null
  const ended = frames.findLast(
    (frame) =>
      frame.method === 'turn/completed' &&
      frame.params?.threadId === threadId &&
      frame.params?.turn?.id === turn.id,
  )
  if (ended) assert.equal(ended.params.turn.status, 'completed', JSON.stringify(ended))
  assert.notEqual(turn.status, 'failed', JSON.stringify(turn))
  return turn.status === 'completed' ? turn : null
}

/** 通知验证运行结果，完整快照验证文字和工具调用；创建早于订阅的开场也可从快照读到。 */
export async function managerReply(
  client,
  threadId,
  expected,
  eventKind = null,
  turnId = null,
  { timeout = 90_000, pollMs = 100 } = {},
) {
  let turn
  await until(
    `会话 ${threadId} 回复 ${expected}`,
    () => client.call('thread/read', { threadId, includeTurns: true }),
    ({ thread }) => {
      turn = completedManagerTurn(thread, client.frames, threadId, eventKind, turnId)
      return turn !== null
    },
    timeout,
    pollMs,
  )
  const answer = turn.items.find(
    (item) => item.type === 'agentMessage' && itemText(item).startsWith(expected),
  )
  assert.ok(answer, `没有收到 ${expected}；回合内容：${JSON.stringify(turn.items)}`)
  if (eventKind)
    assert.ok(
      !turn.items.some((item) => /toolcall|commandexecution/i.test(item.type)),
      `${eventKind} 不应调用工具`,
    )
  return answer.text
}

export async function startManagerFixture(t, engines) {
  // 短路径也让 Claude 的临时套接字不超过它自己的长度限制。
  const root = mkdtempSync('/tmp/lmf-')
  const home = join(root, 'home')
  const codexHome = join(root, 'cx')
  for (const dir of [home, codexHome]) mkdirSync(dir)
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: root,
    LITCH_FIXTURE_DUMP: join(root, 'model'),
    // Go 默认把下载目录设为只读，会使 macOS 上递归清理失败。
    GOFLAGS: '-modcacherw',
    // 构建 Go 只复用公开依赖缓存，不读个人配置和凭据。
    ...(process.env.GOMODCACHE ? { GOMODCACHE: process.env.GOMODCACHE } : {}),
    ...engines,
  }
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENAI_BASE_URL, undefined)
  const names = [
    'pi',
    ...(engines.CHA_CLAUDE_CLI ? ['claude'] : []),
    ...(engines.CHA_CODEX_CLI ? ['codex'] : []),
  ]
  const child = spawn(
    process.execPath,
    [join(repo, 'scripts/device-fixture.mjs'), '--managed', '--engines', names.join(',')],
    {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  let output = ''
  let info
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`夹具 240 秒未就绪：${output}`)), 240_000)
    const collect = (data) => {
      output = (output + data).slice(-40_000)
      const line = output.split('\n').find((line) => line.startsWith('LITCH_DEVICE_FIXTURE '))
      if (!line) return
      clearTimeout(timer)
      info = JSON.parse(line.slice('LITCH_DEVICE_FIXTURE '.length))
      resolve(info)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`夹具提前退出：${signal ?? code}\n${output}`))
    })
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          process.kill(-child.pid, 'SIGKILL')
        }, 45_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill('SIGTERM')
      })
    }
    const cleaned = !info || !existsSync(info.root)
    // 只删除本函数创建的临时根；无论检查是否通过都收场。
    writableDirectories(root)
    rmSync(root, { recursive: true, force: true })
    assert.ok(cleaned, `夹具未清理自己的目录：${info?.root}\n${output}`)
    assert.equal(child.signalCode, null, '夹具被强杀，不能算清理成功')
  })
  return { ...(await ready), modelDump: env.LITCH_FIXTURE_DUMP }
}

export async function managerClient(t, socket) {
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => net.createConnection(socket),
    handshakeTimeout: 10_000,
  })
  const pending = new Map()
  t.after(() => ws.terminate())
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0
  const frames = []
  const rejectPending = (error) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  ws.on('error', rejectPending)
  ws.on('close', () => rejectPending(new Error('设备连接已关闭')))
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString())
    if (frame.method) {
      frames.push(frame)
      return
    }
    const entry = pending.get(frame.id)
    pending.delete(frame.id)
    if (frame.error) entry?.reject(Object.assign(new Error(frame.error.message), frame.error))
    else entry?.resolve(frame.result)
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`RPC 超时：${method}`))
      }, 90_000)
      pending.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      ws.send(JSON.stringify({ id: requestId, method, params }))
    })
  await call('initialize', {
    clientInfo: { name: 'litch-manager-fixture', title: null, version: '0.0.1' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      litchExtensions: [
        'harness',
        'deviceWorkspaces',
        'sessionTree',
        'clientTools',
        'litchManager',
      ],
      litchClientTools: { namespaces: [] },
    },
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  return { call, frames }
}
