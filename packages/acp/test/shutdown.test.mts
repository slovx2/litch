import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Terminals } from '../src/client-side.mjs'
import { AcpServer } from '../src/server.mjs'
import { client, isolate, text } from './client.mjs'

// 收场：适配器退出时 agent 跟着退（先关标准输入，不退的发结束信号，再不退强杀），agent 起的终端也收掉。

const ADAPTER = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function agentEvents(log: string): Promise<any[]> {
  const content = await readFile(log, 'utf8').catch(() => '')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function closeWith(extra: Record<string, string>): Promise<{ events: any[]; ms: number }> {
  const env = await isolate(extra)
  const server = new AcpServer(env.home, env.env)
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    await desktop.call('turn/start', { threadId: thread.id, input: text('wait') })
    await desktop.until('item/agentMessage/delta')
    const pid = server.runtime.current()?.child.pid as number
    const started = Date.now()
    await server.close()
    const ms = Date.now() - started
    assert.equal(alive(pid), false, 'agent 进程收掉了')
    return { events: await agentEvents(join(env.root, 'agent-messages.jsonl')), ms }
  } finally {
    await env.restore()
  }
}

test('agent 读到标准输入关了自己退：不发信号', async () => {
  const { events, ms } = await closeWith({})
  assert.ok(events.some((entry) => entry.event === 'eof'))
  assert.ok(!events.some((entry) => entry.event === 'sigterm'))
  assert.ok(ms < 1500, `收场用了 ${ms}ms`)
})

test('标准输入关了不退的 agent：发结束信号', async () => {
  const { events } = await closeWith({ FAKE_ACP_IGNORE_EOF: '1' })
  assert.ok(events.some((entry) => entry.event === 'sigterm'))
})

test('信号也不理的 agent：到点强杀', async () => {
  const { events, ms } = await closeWith({ FAKE_ACP_IGNORE_EOF: '1', FAKE_ACP_IGNORE_TERM: '1' })
  assert.ok(events.some((entry) => entry.event === 'sigterm'))
  assert.ok(ms >= 3500 && ms < 8000, `收场用了 ${ms}ms`)
})

test('agent 起的终端：收场时整组结束', async () => {
  const terminals = new Terminals(() => {})
  const { terminalId } = terminals.create({
    sessionId: 's',
    command: 'sh',
    args: ['-c', 'sleep 30 & sleep 30'],
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const started = Date.now()
  await terminals.closeAll()
  assert.ok(Date.now() - started < 3000)
  await assert.rejects(Promise.resolve().then(() => terminals.output({ terminalId })))
})

test('入口进程：客户端关了标准输入，适配器和 agent 一起退出', async () => {
  const env = await isolate()
  try {
    const child = spawn(process.execPath, [ADAPTER, 'app-server', '--listen', 'stdio://'], {
      env: { ...env.env, CHA_ACP_HOME: env.home },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const replies: any[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, index)))
        buffer = buffer.slice(index + 1)
      }
    })
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const reply = async (id: number) => {
      for (let waited = 0; waited < 10000; waited += 20) {
        const found = replies.find((entry) => entry.id === id)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等不到应答 ${id}`)
    }
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 't', version: '0' } } })
    await reply(1)
    send({ id: 2, method: 'thread/start', params: { cwd: env.cwd } })
    const started = await reply(2)
    assert.ok(started.result.thread.id)
    const pid = (await agentEvents(join(env.root, 'agent-messages.jsonl')))[0].pid
    assert.equal(alive(pid), true)
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    child.stdin.end()
    assert.equal(await exited, 0)
    assert.equal(alive(pid), false)
  } finally {
    await env.restore()
  }
})
