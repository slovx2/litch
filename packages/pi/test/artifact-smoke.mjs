// 从解包后的独立制品运行；不依赖源码、开发依赖或宿主模型凭据。
// 制品不含 Pi 本体，PI_CLI 必须指向宿主安装的 Pi。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const runtime = resolve(process.argv[2])
assert.ok(process.env.PI_CLI, '需要 PI_CLI 指向宿主安装的 Pi')
const root = await mkdtemp(join(tmpdir(), 'pi-artifact-'))
const home = join(root, 'home'),
  agent = join(home, '.pi', 'agent'),
  cwd = join(root, 'project')
const events = [],
  pending = new Map(),
  waiters = []
let child,
  sequence = 0,
  requests = 0,
  stderr = ''
const mock = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: 'artifact', object: 'chat.completion.chunk', created: 1, model: body.model }
  const writing = requests === 1
  response.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            ...(writing
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'artifact-write',
                      type: 'function',
                      function: {
                        name: 'write',
                        arguments: JSON.stringify({
                          path: join(cwd, 'agent-file.txt'),
                          content: '1234567890',
                        }),
                      },
                    },
                  ],
                }
              : { content: 'artifact SDK reply' }),
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  )
  response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: writing ? 'tool_calls' : 'stop' }] })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
})
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const wait = (predicate) => {
  const old = events.find(predicate)
  return old ? Promise.resolve(old) : new Promise((resolve) => waiters.push({ predicate, resolve }))
}
const timeout = setTimeout(() => {
  console.error('制品验收超时', stderr)
  child?.kill('SIGKILL')
}, 60000)
try {
  await mkdir(agent, { recursive: true })
  await mkdir(cwd)
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  await writeFile(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            {
              id: 'gate',
              name: 'Gate',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  child = spawn(join(runtime, 'bin', 'codex-harness-adapter-pi'), ['app-server'], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_CLI: process.env.PI_CLI,
      CHA_PI_HOME: join(root, 'state'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })
  child.once('exit', () => {
    for (const p of pending.values()) p.reject(new Error(`制品提前退出: ${stderr}`))
    for (const w of waiters) w.resolve({ error: '制品提前退出' })
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id && !message.method) {
      const p = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) p?.reject(new Error(JSON.stringify(message.error)))
      else p?.resolve(message.result)
    } else {
      events.push(message)
      for (const w of [...waiters])
        if (w.predicate(message)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(message)
        }
    }
  })
  await call('initialize')
  assert.equal((await call('runtime/info')).engine, 'pi')
  const path = join(cwd, 'artifact-file.txt')
  await call('fs/watch', { watchId: 'artifact', path: cwd })
  await call('fs/writeFile', { path, dataBase64: Buffer.from('artifact file').toString('base64') })
  assert.equal(
    Buffer.from((await call('fs/readFile', { path })).dataBase64, 'base64').toString(),
    'artifact file',
  )
  assert.equal((await wait((m) => m.method === 'fs/changed')).params.watchId, 'artifact')
  const found = await call('fuzzyFileSearch', { query: 'artifact-file', roots: [cwd] })
  assert.ok(found.files.some((file) => file.path === 'artifact-file.txt'))
  await call('fs/unwatch', { watchId: 'artifact' })
  await call('process/spawn', {
    processHandle: 'pty',
    cwd,
    tty: true,
    size: { rows: 7, cols: 13 },
    command: ['/bin/sh'],
  })
  await call('process/resizePty', { processHandle: 'pty', size: { rows: 17, cols: 43 } })
  await call('process/writeStdin', {
    processHandle: 'pty',
    deltaBase64: Buffer.from('stty size; printf ARTIFACT_PTY_OK; exit\n').toString('base64'),
  })
  assert.equal(
    (await wait((m) => m.method === 'process/exited' && m.params.processHandle === 'pty')).params
      .exitCode,
    0,
  )
  const output = events
    .filter((m) => m.method === 'process/outputDelta')
    .map((m) => Buffer.from(m.params.deltaBase64, 'base64').toString())
    .join('')
  assert.match(output, /17 43/)
  assert.match(output, /ARTIFACT_PTY_OK/)
  await call('process/spawn', { processHandle: 'kill', cwd, tty: true, command: ['/bin/sh'] })
  await call('process/kill', { processHandle: 'kill' })
  await wait((m) => m.method === 'process/exited' && m.params.processHandle === 'kill')
  const { project } = await call('project/create', {
    name: 'artifact',
    roots: [{ path: cwd }],
    idempotencyKey: 'artifact',
  })
  const { thread } = await call('thread/start', { cwd, model: 'gate/gate', projectId: project.id })
  const { turn } = await call('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'artifact SDK test' }],
  })
  assert.equal(
    (await wait((m) => m.method === 'turn/completed' && m.params.turn.id === turn.id)).params.turn
      .status,
    'completed',
  )
  assert.equal(requests, 2)
  assert.equal(await readFile(join(cwd, 'agent-file.txt'), 'utf8'), '1234567890')
  const change = events.find(
    (m) => m.method === 'item/completed' && m.params.item.type === 'fileChange',
  ).params.item.changes[0]
  assert.deepEqual(change.kind, { type: 'add' })
  assert.equal(change.diff, '1234567890')
  const listed = await call('thread/list', { projectId: project.id, cwd: [cwd] })
  assert.equal(listed.data[0].id, thread.id)
  assert.equal(listed.data[0].threadSource, 'user')
  assert.equal(listed.data[0].path, null)
  assert.deepEqual((await call('thread/list', { projectId: null })).data, [])
  // 原生文件仍存在；从 Pi 自己的会话目录验证，不能把它当作 Codex rollout。
  const files = await readdir(join(agent, 'sessions'), { recursive: true })
  const nativePath = files.find((file) => file.endsWith(`_${thread.id}.jsonl`))
  assert.ok(nativePath)
  assert.ok(
    (await readFile(join(agent, 'sessions', nativePath), 'utf8')).includes('artifact SDK reply'),
  )
  child.stdin.end()
  await closed
  console.log('ARTIFACT PASS: 解包启动、文件读写/监听/搜索、PTY 输入/尺寸/关闭、真实 SDK mock 回合')
} finally {
  clearTimeout(timeout)
  child?.kill('SIGTERM')
  mock.closeAllConnections()
  await new Promise((resolve) => mock.close(resolve))
  await rm(root, { recursive: true, force: true })
}
