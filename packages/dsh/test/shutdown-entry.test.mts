import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isolate } from './client.mjs'

// 真的 dsh、真的入口进程，照主进程停运行时的做法停：给入口所在的整个进程组发结束信号
//（cmd/codex-harness-adapter 的 hostplatform.Terminate；dsh 是入口的子进程，在同一个组里，自己也收到）。
// 此前入口收场时再给 dsh 发一个，dsh 收到第二个就丢下收尾立刻退出：回合刚完成时这样停，30 次里有 3 次
// 重读出来那个回合成了被打断的。入口靠“dsh 收场的头一件事是断开连接”认出它已经收到了，
// dsh 换了做法这里的“只收到一个”会先红。关法的各种情形在 shutdown.test.mts（对着假的 dsh）。

const ENTRY = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
const COUNTER = new URL('./count-signals.mjs', import.meta.url).href
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const text = (value: string) => [{ type: 'text', text: value }]

// 入口进程起在自己的进程组里（主进程也是这么起运行时的），经标准输入输出说协议。
function entry(home: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [ENTRY, 'app-server'], {
    detached: true,
    env: { ...process.env, CHA_DSH_HOME: home, ...extra },
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
      for (let waited = 0; waited < 20000; waited += 10) {
        const found = notifications.find((item) => item.method === method && match(item.params))
        if (found) return found.params
        await pause(10)
      }
      throw new Error(`等待通知超时: ${method}: ${diagnostics}`)
    },
  }
}

// 进程组里一个进程都不剩了没有。
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

for (const [whom, wholeGroup] of [
  ['整个进程组都收到结束信号', true],
  ['只有入口进程收到结束信号', false],
] as const)
  test(`dsh：${whom}时，dsh 只收到一个、收尾完才退，入口在主进程给的时限里退干净，刚完成的回合重读还是完成的`, {
    timeout: 120000,
  }, async () => {
    const env = await isolate((body) => [
      { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
    ])
    const home = join(env.root, 'home')
    const signals = join(env.root, 'signals')
    const first = entry(home, { NODE_OPTIONS: `--import=${COUNTER}`, DSH_TEST_SIGNALS: signals })
    let second: ReturnType<typeof entry> | null = null
    try {
      await first.call('initialize', { clientInfo: { name: 'test', version: '0' } })
      const { thread } = await first.call('thread/start', {
        cwd: env.cwd,
        permissions: ':workspace',
      })
      const { turn } = await first.call('turn/start', {
        threadId: thread.id,
        input: text('说一句话。'),
      })
      const done = await first.until('turn/completed', (params) => params.turn.id === turn.id)
      assert.equal(done.turn.status, 'completed')

      // 回合完成的通知一到就停：这时它的结尾多半还没落盘
      const began = Date.now()
      process.kill(wholeGroup ? -first.pid : first.pid, 'SIGTERM')
      assert.deepEqual(await first.exited, { code: 0, signal: null })
      assert.ok(Date.now() - began < 5000, `入口用了 ${Date.now() - began} 毫秒才退出`)
      assert.ok(await groupGone(first.pid, 6000), '入口退出之后进程组里不该还有进程')
      assert.ok(existsSync(signals), 'dsh 没有收到结束信号')
      assert.equal(readFileSync(signals, 'utf8').trim().split('\n').length, 1)

      second = entry(home)
      await second.call('initialize', { clientInfo: { name: 'test', version: '0' } })
      const read = await second.call('thread/read', { threadId: thread.id, includeTurns: true })
      assert.deepEqual(
        read.thread.turns.map((item: any) => [item.id, item.status]),
        [[turn.id, 'completed']],
      )
      process.kill(-second.pid, 'SIGTERM')
      await second.exited
      assert.ok(await groupGone(second.pid, 6000))
    } finally {
      reap(first.pid)
      if (second) reap(second.pid)
      await env.restore()
    }
  })
