// 真 Codex app-server、设备与回环 Responses：检查自定义 provider 的命名请求和失败兜底。
// 先 npm run build --prefix packages/device，再用 CHA_CODEX_CLI 指定待验 CLI 运行本文件。
// 0.163 允许临时命名走内置 OpenAI。0.166 可用 --expect-provider-mismatch 验证上游拒绝时的兜底，
// 或用 --openai-active 验证当前提供商已是内置 OpenAI 时的生成。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { DeviceServer } from '../packages/device/dist/packages/device/src/device.mjs'
import { TestClient } from '../packages/device/dist/packages/device/test/helpers.mjs'
import {
  codexConfig,
  findCodex,
  startResponsesModel,
  userText,
} from './client-fixture-responses.mjs'

const cli = findCodex()
if (!cli) throw new Error('请使用 CHA_CODEX_CLI 指定 Codex CLI')
const openaiActive = process.argv.includes('--openai-active')
const providerBlocks = process.argv.includes('--expect-provider-mismatch')
assert.ok(!(openaiActive && providerBlocks))
const root = mkdtempSync(join(tmpdir(), 'litch-title-'))
const dirs = Object.fromEntries(
  ['home', 'codex', 'work', 'tmp', 'device'].map((k) => [k, join(root, k)]),
)
for (const dir of Object.values(dirs)) mkdirSync(dir)

const requests = []
const mainModel = 'deepseek-fixture'
const failure = '诊断命名接口失败'
const capture = (provider) => (body) => {
  const text = userText(body)
  const title = text.includes('<user_message>')
  const allowed = title
    ? provider === 'openai' && /^gpt-[\d.]+-luna/.test(body.model)
    : body.model === mainModel
  const status = !allowed ? 404 : title && text.includes(failure) ? 400 : 200
  requests.push({ provider, title, model: body.model, status, schema: !!body.text?.format })
  if (status !== 200) return { status }
  return { text: title ? '{"title":"回环生成标题"}' : '主回合完成' }
}
const official = await startResponsesModel(capture('openai'))
const selected = await startResponsesModel(capture('custom'))

const source = codexConfig(selected.baseUrl).replace(
  'model_provider = "fixture"',
  `model_provider = "${openaiActive ? 'openai' : 'fixture'}"`,
)
writeFileSync(
  join(dirs.codex, 'config.toml'),
  [
    `openai_base_url = "${official.baseUrl}"`,
    'cli_auth_credentials_store = "file"',
    source,
    '[features]',
    'enable_request_compression = false',
    'api_key_model_discovery = false',
    '',
  ].join('\n'),
)
writeFileSync(
  join(dirs.codex, 'auth.json'),
  JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-only-api-key' }),
  { mode: 0o600 },
)
const reserve = createServer()
await new Promise((done) => reserve.listen(0, '127.0.0.1', done))
const port = reserve.address().port
await new Promise((done) => reserve.close(done))
const proxy = 'http://127.0.0.1:9'
const child = spawn(cli, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
  cwd: dirs.work,
  env: {
    HOME: dirs.home,
    CODEX_HOME: dirs.codex,
    TMPDIR: dirs.tmp,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: 'localhost,127.0.0.1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (data) => {
  stderr += data
})
const connect = async (handlers) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const opened = await new Promise((done) => {
      ws.once('open', () => done(true))
      ws.once('error', () => done(false))
    })
    if (!opened) {
      await pause(50)
      continue
    }
    ws.on('message', (raw) => handlers.message(raw.toString()))
    ws.on('close', () => handlers.close('isolated Codex closed'))
    return {
      send: (raw) => ws.send(raw),
      close: () => {
        ws.removeAllListeners('message')
        ws.close()
      },
    }
  }
  throw new Error('隔离的 Codex 没有开始监听')
}

const logs = []
const device = new DeviceServer({
  stateDir: dirs.device,
  upstreams: [{ id: 'codex', native: true, connect }],
  importExisting: false,
  wrapUp: false,
  wrapUpReminder: false,
  log: (line) => logs.push(line),
})
const client = new TestClient(device)
try {
  await client.initialize(['harness'])
  for (const [input, expected] of [
    ['检查回环设置', '回环生成标题'],
    [failure, failure],
  ]) {
    const started = await client.call('thread/start', {
      harness: 'codex',
      modelProvider: openaiActive ? 'openai' : 'fixture',
      model: 'configured-fixture',
      cwd: dirs.work,
    })
    assert.equal(started.modelProvider, openaiActive ? 'openai' : 'fixture')
    const threadId = started.thread.id
    if (input === failure)
      await client.call('thread/settings/update', { threadId, model: mainModel })
    const completed = client.waitFor(
      (frame) => frame.method === 'turn/completed' && frame.params.threadId === threadId,
      15_000,
    )
    await client.call('turn/start', {
      threadId,
      ...(input === failure ? {} : { model: mainModel }),
      input: [{ type: 'text', text: input, text_elements: [] }],
    })
    assert.equal((await completed).params.turn.status, 'completed')
    await device.titles.settled()
    const named = await client.call('thread/read', { threadId, includeTurns: false })
    assert.equal(named.thread.name, providerBlocks ? input : expected)
  }
  const main = requests.filter(({ title }) => !title)
  assert.equal(main.length, 2)
  assert.ok(
    main.every(
      ({ provider, model, status }) =>
        provider === (openaiActive ? 'openai' : 'custom') && model === mainModel && status === 200,
    ),
  )
  const naming = requests.filter(({ title }) => title)
  if (providerBlocks) {
    assert.deepEqual(naming, [], '提供商不匹配时，上游不会发送命名请求')
    assert.ok(logs.some((line) => line.includes('不允许向非当前提供商启动回合')))
  } else {
    assert.deepEqual(
      naming.map(({ status }) => status),
      [200, 400],
    )
    assert.ok(naming.every(({ provider, schema }) => provider === 'openai' && schema))
    assert.ok(naming.every(({ model }) => /^gpt-[\d.]+-luna/.test(model)))
  }
  assert.ok(logs.some((line) => line.includes('使用首条消息作为标题')))
  console.log(
    providerBlocks
      ? 'Codex 拒绝跨提供商命名：未发出 Luna 请求，写入首条消息兜底。'
      : '非 GPT 主回合：内置 OpenAI GPT Luna 生成标题；HTTP 400 时写入首条消息兜底。',
  )
} finally {
  console.log('回环请求：', JSON.stringify(requests))
  for (const line of logs.filter((line) => /起名|标题/.test(line))) console.log(line)
  if (process.env.LITCH_CODEX_TITLE_TRACE === '1' && stderr) console.log(stderr)
  client.close()
  await device.close()
  official.close()
  selected.close()
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    const force = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.kill('SIGTERM')
    await exited
    clearTimeout(force)
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
