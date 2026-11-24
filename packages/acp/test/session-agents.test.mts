import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { githubCommandThread } from '../../device/src/external/device-agent-command.mjs'
import { deviceGithubEnvironmentSocket } from '../../shared/src/device-github-environment.mjs'
import { AcpServer } from '../src/server.mjs'
import { client, isolate, text } from './client.mjs'

// Gemini 的已注入会话各用一个 agent 进程，进程环境里带 LITCH_THREAD_ID（session-agents.mts）。
// 假 agent 起来时记下自己环境里的会话号，收到的每条消息带着进程号（fake-agent.mts）。

/** 假设备：probe 时 injected 里有的会话算已注入；configured 答设备上有没有经理开着注入 */
async function fakeDevice(
  socketDir: string,
  injected: Set<string>,
  configured = true,
): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!buffer.endsWith('\n')) return
      const request = JSON.parse(buffer)
      socket.end(
        JSON.stringify(
          request.action === 'probe'
            ? { injected: injected.has(request.threadId) }
            : request.action === 'configured'
              ? { injected: configured }
              : {},
        ),
      )
    })
  })
  const path = deviceGithubEnvironmentSocket(join(socketDir, 'device.sock'))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}

/** Gemini 入口的环境：设备套接字和 harness 名都给上 */
function geminiEnv(base: Awaited<ReturnType<typeof isolate>>): NodeJS.ProcessEnv {
  return {
    ...base.env,
    CHA_ACP_AGENT: 'gemini',
    CHA_GEMINI_CLI: base.env.CHA_ACP_CLI as string,
    CHA_GEMINI_ARGS: base.env.CHA_ACP_ARGS as string,
    LITCH_DEVICE_SOCKET: join(base.root, 'device.sock'),
    LITCH_DEVICE_GITHUB_HARNESS: 'gemini',
  }
}

test('Gemini：新会话先单独建；发过话后已注入的留在自己的进程，其余回到共用进程', {
  skip: process.platform === 'win32',
}, async () => {
  const injected = new Set<string>()
  const base = await isolate()
  const device = await fakeDevice(base.root, injected)
  const server = new AcpServer(base.home, geminiEnv(base))
  const desktop = client(server)
  try {
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const run = async (threadId: string, said: string) => {
      const { turn: started } = await desktop.call('turn/start', { threadId, input: text(said) })
      const done = await desktop.until(
        'turn/completed',
        (p) => p.turn.id === started.id && p.threadId === threadId,
      )
      assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    }
    const entries = async () =>
      (await readFile(join(base.root, 'agent-messages.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    /** 收到这个会话最后一次 session/prompt 的进程，和那个进程的会话号文件里写的会话号 */
    const promptedBy = async (sessionId: string) => {
      const all = await entries()
      const prompt = all
        .filter(
          (e) =>
            e.message?.method === 'session/prompt' && e.message.params?.sessionId === sessionId,
        )
        .at(-1)
      assert.ok(prompt, `${sessionId} 没收到提示词`)
      const file = all.find((e) => e.started && e.pid === prompt.pid)?.threadFile
      return {
        pid: prompt.pid as number,
        thread: file
          ? githubCommandThread({
              LITCH_DEVICE_GITHUB_HARNESS: 'gemini',
              LITCH_THREAD_ID_FILE: file,
            })
          : null,
      }
    }

    const { thread: line } = await desktop.call('thread/start', { cwd: base.cwd })
    const { thread: plain } = await desktop.call('thread/start', { cwd: base.cwd })
    injected.add(line.id)
    await run(line.id, '你好')
    await run(plain.id, '你好')
    const own = await promptedBy(line.id)
    const first = await promptedBy(plain.id)
    assert.equal(own.thread, line.id, '命令入口从会话号文件认出的就是这个会话')
    assert.equal(first.thread, plain.id, '普通会话的第一回合也在自己的进程里（还没写盘，不能换）')
    assert.notEqual(own.pid, first.pid)

    // 第二回合：已注入的留在自己的进程，普通会话回到共用进程，它自己的进程结束
    await run(line.id, '再来')
    await run(plain.id, '再来')
    assert.equal((await promptedBy(line.id)).pid, own.pid)
    const shared = await promptedBy(plain.id)
    assert.equal(shared.thread, null, '共用进程没有会话号')
    assert.notEqual(shared.pid, first.pid)
    assert.throws(() => process.kill(first.pid, 0), '普通会话自己的进程已经结束')

    // 不再注入：关掉自己的进程，回到共用的
    injected.delete(line.id)
    await run(line.id, '又一回合')
    assert.equal((await promptedBy(line.id)).pid, shared.pid)
    assert.throws(() => process.kill(own.pid, 0), '会话自己的进程已经结束')

    // 再注入：发过话的会话换到新起的自己的进程
    injected.add(line.id)
    await run(line.id, '最后一回合')
    const again = await promptedBy(line.id)
    assert.notEqual(again.pid, shared.pid)
    assert.equal(again.thread, line.id)
  } finally {
    await server.close()
    device.close()
    await base.restore()
  }
})

test('Gemini：设备上没人开注入时，新会话照旧在共用进程里建', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await isolate()
  const device = await fakeDevice(base.root, new Set(), false)
  const server = new AcpServer(base.home, geminiEnv(base))
  const desktop = client(server)
  try {
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', { cwd: base.cwd })
    assert.equal(server.agents.owns(thread.id), false)
    const { turn: started } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('你好'),
    })
    await desktop.until('turn/completed', (p) => p.turn.id === started.id)
    const agents = (await readFile(join(base.root, 'agent-messages.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.started)
    assert.equal(agents.length, 1, '只起了共用进程')
    assert.equal(agents[0].threadFile, null)
  } finally {
    await server.close()
    device.close()
    await base.restore()
  }
})

test('不是 Gemini 的 ACP 入口不为会话单独起进程', async () => {
  const injected = new Set<string>()
  const base = await isolate()
  const device = await fakeDevice(base.root, injected)
  const server = new AcpServer(base.home, {
    ...base.env,
    LITCH_DEVICE_SOCKET: join(base.root, 'device.sock'),
    LITCH_DEVICE_GITHUB_HARNESS: 'acp',
  })
  const desktop = client(server)
  try {
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', { cwd: base.cwd })
    injected.add(thread.id)
    const { turn: started } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('你好'),
    })
    await desktop.until('turn/completed', (p) => p.turn.id === started.id)
    assert.equal(server.agents.owns(thread.id), false)
  } finally {
    await server.close()
    device.close()
    await base.restore()
  }
})
