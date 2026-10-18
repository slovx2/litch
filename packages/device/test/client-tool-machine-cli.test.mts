// litch-machine 一路跑通：真的命令行（仓库根目录 bin/ 里由 scripts/build-cli.mjs 编出来的那一份，按短名调用）
// 经真的 unix 套接字连设备进程，设备进程挑一条 Litch 连接发 litch/clientTool/call，这边的假 Litch 答复，
// 看命令行打出来的和退出码。挑哪条连接的各种情形在 client-tool-invoke.test.mts，这里只看两头接得上。
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLIENT_TOOL_METHOD } from '../../protocol/src/client-tools.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig, type TestClient } from './helpers.mjs'

const MACHINE = 'litch_machine'
/** 短名：bin/litch-machine 是指向 codex-harness-adapter 的链接，按这个名字调用就是 machine 子命令 */
const CLI = fileURLToPath(
  new URL(
    `../../../../../bin/${process.platform === 'win32' ? 'litch-machine.exe' : 'litch-machine'}`,
    import.meta.url,
  ),
)

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

function machine(socket: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(CLI, args, {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CHA_LANG: 'zh-CN',
      LITCH_DEVICE_SOCKET: socket,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const done = new Promise<Ran>((resolve) =>
    child.on('close', (code) => resolve({ code, stdout, stderr })),
  )
  return { child, done }
}

async function setup() {
  const pi = new FakeUpstream('pi', [{ id: 'p1', updatedAt: 300 }])
  pi.handlers['turn/start'] = (params) => {
    const turn = { id: `turn-of-${params.threadId}`, status: 'inProgress' }
    queueMicrotask(() => pi.notify('turn/started', { threadId: params.threadId, turn }))
    return { turn }
  }
  const env = rig({ pi })
  const socket = join(env.stateDir, 'device.sock')
  const listener = await listenUnix(socket, (wire) => env.device.attach(wire))
  return {
    env,
    socket,
    async close() {
      await listener.close()
      await env.close()
    },
  }
}

async function litch(env: ReturnType<typeof rig>, hostname: string): Promise<TestClient> {
  const client = env.connect()
  await client.initialize(['harness', 'clientTools'], {
    litchClientTools: { namespaces: [MACHINE], desktop: { hostname, name: `${hostname} 的桌面` } },
  })
  return client
}

const callOf = (client: TestClient) =>
  client.waitFor((frame) => frame.method === CLIENT_TOOL_METHOD.call, 10_000)

const textReply = (text: string, success = true) => ({
  success,
  contentItems: [{ type: 'inputText', text }],
})

test('MACHINE-CLI-001：没有 Litch 连着时退出码 75，说清楚原因', async () => {
  const s = await setup()
  try {
    const ran = await machine(s.socket, ['machines']).done
    assert.equal(ran.code, 75, ran.stderr)
    assert.match(ran.stderr, /^\[litch:noExecutor\] /)
    assert.equal(ran.stdout, '')
  } finally {
    await s.close()
  }
})

test('MACHINE-CLI-002：exec 交到 Litch，输出打到标准输出，退出码是命令自己的；会话号随着去', async () => {
  const s = await setup()
  let child: ChildProcess | null = null
  try {
    const mac = await litch(s.env, 'mac')
    const run = machine(s.socket, ['exec', '--cwd', '/tmp', 'ls', '-la'], { PI_SESSION_ID: 'p1' })
    child = run.child
    const frame = await callOf(mac)
    const params = frame.params as Record<string, any>
    assert.equal(params.namespace, MACHINE)
    assert.equal(params.tool, 'exec')
    assert.deepEqual(params.arguments, { command: 'ls -la', cwd: '/tmp' })
    assert.match(String(params.threadId), /p1$/)
    mac.answer(
      frame.id,
      textReply('status: exited\nexit_code: 3\nduration_ms: 12\nseq: 2\noutput:\ntotal 0\n'),
    )
    const ran = await run.done
    assert.equal(ran.code, 3, ran.stderr)
    assert.equal(ran.stdout, 'total 0\n')
  } finally {
    child?.kill()
    await s.close()
  }
})

test('MACHINE-CLI-003：两台 Litch 时 76 并列出主机名；--desktop 交给对得上的那台；--json 原样', async () => {
  const s = await setup()
  try {
    const mac = await litch(s.env, 'mac')
    const pc = await litch(s.env, 'pc')
    const ambiguous = await machine(s.socket, ['ls', '/']).done
    assert.equal(ambiguous.code, 76, ambiguous.stderr)
    assert.match(ambiguous.stderr, /mac/)
    assert.match(ambiguous.stderr, /pc/)
    assert.match(ambiguous.stderr, /--desktop/)

    const run = machine(s.socket, ['read', '/etc/hosts', '--desktop', 'pc', '--json'])
    const frame = await callOf(pc)
    assert.equal((frame.params as any).tool, 'read_file')
    pc.answer(frame.id, textReply('127.0.0.1 localhost'))
    const ran = await run.done
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(JSON.parse(ran.stdout), textReply('127.0.0.1 localhost'))
    assert.equal(mac.requests.filter((item) => item.method === CLIENT_TOOL_METHOD.call).length, 0)
  } finally {
    await s.close()
  }
})

test('MACHINE-CLI-004：用户拒绝是 77；命令行被结束时 Litch 那边的请求被撤回', async () => {
  const s = await setup()
  try {
    const mac = await litch(s.env, 'mac')
    const declined = machine(s.socket, ['write', '/tmp/x', '--content', 'y'])
    const first = await callOf(mac)
    mac.answer(first.id, textReply('[litch:declined] 用户拒绝了', false))
    const ran = await declined.done
    assert.equal(ran.code, 77, ran.stderr)
    assert.match(ran.stderr, /用户拒绝了/)

    const waiting = machine(s.socket, ['exec', 'sleep', '100'])
    const second = await mac.waitFor(
      (frame) => frame.method === CLIENT_TOOL_METHOD.call && frame.id !== first.id,
      10_000,
    )
    waiting.child.kill('SIGTERM')
    await waiting.done
    const resolved = await mac.waitFor(
      (frame) =>
        frame.method === 'serverRequest/resolved' && (frame.params as any).requestId === second.id,
      10_000,
    )
    assert.ok(resolved)
  } finally {
    await s.close()
  }
})
