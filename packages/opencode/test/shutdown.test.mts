import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isolate, skip, text } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 真的入口进程、真的 opencode serve：入口起在自己的进程组里（主进程起运行时就是这样），
// 几种停法（整个进程组收到结束信号、只有入口收到、标准输入关掉、入口被强杀）之后，入口和 serve 都要在时限里退干净，
// 刚完成的回合重读出来还是完成的。

const ENTRY = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function entry(home: string) {
  const child = spawn(process.execPath, [ENTRY, 'app-server'], {
    detached: true,
    env: { ...process.env, CHA_OPENCODE_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  child.stderr.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-4000)
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal })),
  )
  const replies = new Map<number, any>()
  const notifications: any[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method) notifications.push(message)
    else replies.set(message.id, message)
  })
  let sequence = 0
  return {
    pid: child.pid as number,
    child,
    exited,
    async call(method: string, params: unknown = {}): Promise<any> {
      const id = ++sequence
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      for (let waited = 0; waited < 30000 && !replies.has(id); waited += 10) {
        if (child.exitCode !== null) throw new Error(`入口提前退出: ${diagnostics}`)
        await pause(10)
      }
      const reply = replies.get(id)
      if (!reply) throw new Error(`${method} 没有应答: ${diagnostics}`)
      if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
      return reply.result
    },
    async until(method: string, match: (params: any) => boolean): Promise<any> {
      for (let waited = 0; waited < 30000; waited += 10) {
        const found = notifications.find((item) => item.method === method && match(item.params))
        if (found) return found.params
        await pause(10)
      }
      throw new Error(`等待通知超时: ${method}: ${diagnostics}`)
    },
  }
}

// 进程组里一个进程都不剩了没有
async function groupGone(group: number, limitMs: number): Promise<boolean> {
  for (let waited = 0; waited < limitMs; waited += 20) {
    try {
      process.kill(-group, 0)
    } catch {
      return true
    }
    await pause(20)
  }
  return false
}

function reap(group: number): void {
  try {
    process.kill(-group, 'SIGKILL')
  } catch {
    /* 已经没有了 */
  }
}

const STOPS = {
  整个进程组收到结束信号: (pid: number) => process.kill(-pid, 'SIGTERM'),
  只有入口收到结束信号: (pid: number) => process.kill(pid, 'SIGTERM'),
  // 收不了场：serve 由旁边看着它的 sh 结束（runtime.mts 的 watchdog）
  入口被强杀: (pid: number) => process.kill(pid, 'SIGKILL'),
} as const

for (const [whom, stop] of [...Object.entries(STOPS), ['标准输入关掉', null] as const])
  test(`OpenCode：${whom}时，入口和 serve 都退干净，刚完成的回合重读还是完成的`, {
    skip,
    timeout: 120000,
  }, async () => {
    const env = await isolate(scripted({}))
    const first = entry(env.home)
    let second: ReturnType<typeof entry> | null = null
    try {
      await first.call('initialize', { clientInfo: { name: 'test', version: '0' } })
      const { thread } = await first.call('thread/start', { cwd: env.cwd })
      const { turn } = await first.call('turn/start', {
        threadId: thread.id,
        input: text('说一句话。'),
      })
      const done = await first.until('turn/completed', (params) => params.turn.id === turn.id)
      assert.equal(done.turn.status, 'completed')

      const began = Date.now()
      if (stop) stop(first.pid)
      else first.child.stdin.end()
      const exit = await first.exited
      if (whom === '入口被强杀') assert.equal(exit.signal, 'SIGKILL')
      else assert.equal(exit.code, 0, JSON.stringify(exit))
      assert.ok(Date.now() - began < 8000, `入口用了 ${Date.now() - began} 毫秒才退出`)
      assert.ok(
        await groupGone(first.pid, 8000),
        '入口退出之后进程组里不该还有进程（serve 也要退）',
      )

      second = entry(env.home)
      await second.call('initialize', { clientInfo: { name: 'test', version: '0' } })
      const read = await second.call('thread/read', { threadId: thread.id, includeTurns: true })
      assert.deepEqual(
        read.thread.turns.map((item: any) => [item.id, item.status]),
        [[turn.id, 'completed']],
      )
      process.kill(-second.pid, 'SIGTERM')
      await second.exited
      assert.ok(await groupGone(second.pid, 8000))
    } finally {
      reap(first.pid)
      if (second) reap(second.pid)
      await env.restore()
    }
  })
