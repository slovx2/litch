import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import { WebSocket } from 'ws'
import { MockLLM } from '../packages/claude/dist/claude/test/fixtures/mock-llm.mjs'

// 真实 SDK 经真实 SSH 与 WebSocket 接入；此测试不代表桌面 GUI 验收。
const windows = process.platform === 'win32'
const root = await mkdtemp(join(windows ? tmpdir() : '/tmp', 'cha-ssh-'))
const cli = resolve(`bin/codex-harness-adapter${windows ? '.exe' : ''}`)
const sshCommand = windows ? join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh'
const active = []
const models = []
let calls = 0
const piModel = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  calls++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: 'ssh-test', object: 'chat.completion.chunk', created: 1, model: body.model }
  response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'PI_SSH_OK' }, finish_reason: null }] })}\n\n`,
  )
  response.end(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  )
})
await new Promise((resolve) => piModel.listen(0, '127.0.0.1', resolve))

async function runHarness(harness, port) {
  const home = join(root, harness)
  await mkdir(home, { recursive: true })
  const env = {
    PATH: windows ? process.env.PATH : `${dirname(process.execPath)}:/usr/bin:/bin`,
    // 下面按中文提示判断“检查通过”“SSH 就绪”，命令行的输出语言不跟着这台机器走
    CHA_LANG: 'zh-CN',
    ...(windows
      ? {
          SystemRoot: process.env.SystemRoot,
          SystemDrive: process.env.SystemDrive,
          ProgramData: process.env.ProgramData,
          USERNAME: process.env.USERNAME,
          USERDOMAIN: process.env.USERDOMAIN,
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          APPDATA: join(home, 'AppData', 'Roaming'),
          WINDIR: process.env.WINDIR,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          TEMP: root,
          TMP: root,
          USERPROFILE: home,
          CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH,
        }
      : {}),
    HOME: home,
    SHELL: '/bin/sh',
    TMPDIR: root,
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    CHA_CLAUDE_CLI: resolve(
      windows
        ? '.artifacts/host-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
        : '.artifacts/host-cli/node_modules/.bin/claude',
    ),
    PI_CLI: resolve(
      windows
        ? 'packages/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
        : 'packages/pi/node_modules/.bin/pi',
    ),
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_API_KEY: 'test-only',
  }
  let mock
  if (harness === 'claude-code') {
    mock = new MockLLM()
    models.push(mock)
    env.ANTHROPIC_BASE_URL = await mock.start()
    mock.enqueue(() => [{ type: 'text', text: 'CLAUDE_SSH_OK' }])
  } else {
    await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true })
    await writeFile(
      join(env.PI_CODING_AGENT_DIR, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: `http://127.0.0.1:${piModel.address().port}/v1`,
            api: 'openai-completions',
            apiKey: 'test-only',
            models: [
              {
                id: 'ssh-test',
                name: 'SSH Test',
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
  }
  const args = [
    '--harness',
    harness,
    '--home',
    join(root, 'state'),
    '--port',
    String(port),
    '--node',
    process.execPath,
  ]
  let result = spawnSync(cli, ['init', ...args], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const doctor = spawnSync(cli, ['doctor', ...args], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout)
  const internalOutput = /releaseReady|cliSha256|ExperimentalWarning|pty-self-check ok/
  assert.match(doctor.stdout, /检查通过/)
  assert.doesNotMatch(doctor.stdout + doctor.stderr, internalOutput)
  result = spawnSync(cli, ['ssh-config', ...args], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const config = join(home, 'ssh_config')
  await writeFile(config, result.stdout)
  const service = spawn(cli, ['start', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  active.push(service)
  let errors = ''
  let serviceOutput = ''
  service.stdout.on('data', (chunk) => {
    serviceOutput += chunk
  })
  service.stderr.on('data', (chunk) => {
    errors += chunk
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSH 启动超时: ${errors}`)), 30000)
    service.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`SSH 提前退出 ${code}: ${errors}`))
    })
    service.stdout.on('data', (data) => {
      if (data.toString().includes('SSH 就绪')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const alias = `codex-harness-adapter-${harness === 'pi' ? 'pi' : 'claude'}`
  const sshArgs = ['-F', config, '-o', 'BatchMode=yes', alias]
  const version = spawnSync(sshCommand, ['-v', ...sshArgs, 'codex --version'], {
    env,
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.equal(
    version.status,
    0,
    JSON.stringify({
      stderr: version.stderr,
      stdout: version.stdout,
      error: String(version.error ?? ''),
      signal: version.signal,
      serviceErrors: errors,
    }),
  )
  assert.match(version.stdout, /codex-cli 0\.157\.1/)
  const ssh = spawn(sshCommand, [...sshArgs, 'codex app-server proxy'], { env })
  active.push(ssh)
  ssh.stderr.on('data', (chunk) => {
    errors += chunk
  })
  const stream = Duplex.from({ readable: ssh.stdout, writable: ssh.stdin })
  const ws = new WebSocket('ws://localhost/', { createConnection: () => stream })
  await once(ws, 'open')
  let sequence = 0
  const pending = new Map()
  const notifications = []
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if ('id' in message && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    } else notifications.push(message)
  })
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 超时: ${errors}`))
      }, 30000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    await rpc('initialize', {
      clientInfo: { name: 'ssh-test', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    })
    const command = await rpc('command/exec', {
      cwd: home,
      command: [
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync("ssh-command.txt", "COMMAND_OK"); console.log("COMMAND_OK")',
      ],
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    assert.equal(command.exitCode, 0, JSON.stringify(command))
    assert.equal(await readFile(join(home, 'ssh-command.txt'), 'utf8'), 'COMMAND_OK')
    const terminal = await rpc('command/exec', {
      processId: 'ssh-pty',
      cwd: home,
      command: [process.execPath, '-e', 'console.log(process.stdout.isTTY ? "PTY_OK" : "NO_PTY")'],
      tty: true,
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    assert.equal(terminal.exitCode, 0, JSON.stringify(terminal))
    const terminalOutput = notifications
      .filter(
        (message) =>
          message.method === 'command/exec/outputDelta' && message.params.processId === 'ssh-pty',
      )
      .map((message) => Buffer.from(message.params.deltaBase64, 'base64').toString())
      .join('')
    assert.match(terminalOutput, /PTY_OK/)
    const { thread } = await rpc('thread/start', {
      cwd: home,
      model: harness === 'pi' ? 'local/ssh-test' : 'claude-sonnet-4-6',
      ...(windows ? { sandbox: 'danger-full-access', approvalPolicy: 'never' } : {}),
    })
    const { turn } = await rpc('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '验证本地 SSH 接入' }],
    })
    const deadline = Date.now() + 30000
    let completion
    while (Date.now() < deadline) {
      completion = notifications.find(
        (m) => m.method === 'turn/completed' && m.params.turn.id === turn.id,
      )
      if (completion) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(
      completion?.params.turn.status,
      'completed',
      JSON.stringify(completion ?? { errors }),
    )
    const history = await rpc('thread/read', { threadId: thread.id, includeTurns: true })
    assert.match(JSON.stringify(history), harness === 'pi' ? /PI_SSH_OK/ : /CLAUDE_SSH_OK/)
    if (mock) assert.ok(mock.requests.length > 0)
    else assert.ok(calls > 0)
    assert.doesNotMatch(serviceOutput + errors, internalOutput)
    console.log(`${harness}: SSH 认证、版本探测、WebSocket、真实 SDK 回合及历史 PASS`)
  } finally {
    ws.close()
    ssh.kill()
    const closed = once(service, 'exit')
    service.kill('SIGTERM')
    await closed
    if (!windows) assert.equal(service.exitCode, 0, errors)
    await assert.rejects(readFile(join(root, 'state', harness, 'runtime.sock')))
  }
}

try {
  // 独立于用户默认入口，避免打断现有开发服务。
  await runHarness('pi', 17332)
  await runHarness('claude-code', 17331)
} finally {
  for (const process of active) if (process.exitCode === null) process.kill('SIGTERM')
  for (const model of models) await model.close()
  await new Promise((resolve) => piModel.close(resolve))
  // 进程是刚刚才叫停的，还没退干净：Windows 上它手里的日志文件这时候删不掉（EBUSY），等一等再删
  await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
}
