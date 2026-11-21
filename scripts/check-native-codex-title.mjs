// 真 Codex app-server、设备与回环 Responses：检查自定义 provider 的命名请求和失败兜底。
// 先 npm run build --prefix packages/device，再用 CHA_CODEX_CLI 指定待验 CLI 运行本文件。
// 默认由同一个自定义网关提供非 GPT 主模型和 GPT Luna。--openai-active 验内置 OpenAI。
// --check-provider-mismatch 用 Codex 0.166+ 单独验证它拒绝向非当前 provider 发起回合。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
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
const checkMismatch = process.argv.includes('--check-provider-mismatch')
assert.ok(!(openaiActive && checkMismatch))
const root = mkdtempSync(join(tmpdir(), 'litch-title-'))
const dirs = Object.fromEntries(
  ['home', 'codex', 'work', 'tmp', 'device'].map((k) => [k, join(root, k)]),
)
for (const dir of Object.values(dirs)) mkdirSync(dir)

const requests = []
const gateway = 'gateway-fixture'
const active = openaiActive ? 'openai' : gateway
const mainModel = 'deepseek-fixture'
const gptModel = 'gpt-5.6-sol'
const lunaModel = 'gpt-5.6-luna'
const failure = '诊断命名接口失败'
const capture = (provider) => (body) => {
  const text = userText(body)
  const title = text.includes('<user_message>')
  const allowed = provider === active && body.model === (title ? lunaModel : mainModel)
  const status = !allowed ? 404 : title && text.includes(failure) ? 400 : 200
  requests.push({ provider, title, model: body.model, status, schema: !!body.text?.format })
  if (status !== 200) return { status }
  return { text: title ? '{"title":"回环生成标题"}' : '主回合完成' }
}
const official = await startResponsesModel(capture('openai'))
const selected = await startResponsesModel(capture(gateway))
const proxy = 'http://127.0.0.1:9'
const isolated = {
  HOME: dirs.home,
  CODEX_HOME: dirs.codex,
  TMPDIR: dirs.tmp,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HTTP_PROXY: proxy,
  HTTPS_PROXY: proxy,
  ALL_PROXY: proxy,
  NO_PROXY: 'localhost,127.0.0.1',
}

// 用官方底稿构造只公布这三个模型的网关清单，Luna 型号与网关实际支持的一致。
const bundled = JSON.parse(
  execFileSync(cli, ['debug', 'models', '--bundled'], { cwd: dirs.work, env: isolated }),
).models
const luna = bundled.find(({ slug }) => slug === lunaModel)
const gpt =
  bundled.find(({ slug }) => slug === gptModel) ?? bundled.find(({ slug }) => slug === 'gpt-6-sol')
assert.ok(luna && gpt)
const catalog = join(dirs.codex, 'catalog.json')
writeFileSync(
  catalog,
  JSON.stringify({
    models: [
      luna,
      { ...gpt, slug: gptModel },
      {
        ...gpt,
        slug: mainModel,
        display_name: 'DeepSeek fixture',
      },
    ],
  }),
)
const source = codexConfig(selected.baseUrl)
  .replace('model = "fixture-gate"', `model = "${gptModel}"`)
  .replace('model_provider = "fixture"', `model_provider = "${active}"`)
  .replace('[model_providers.fixture]', `[model_providers.${gateway}]`)
writeFileSync(
  join(dirs.codex, 'config.toml'),
  [
    `openai_base_url = "${official.baseUrl}"`,
    'cli_auth_credentials_store = "file"',
    `model_catalog_json = "${catalog}"`,
    source,
    '[features]',
    'enable_request_compression = false',
    'api_key_model_discovery = false',
    '',
  ].join('\n'),
)
if (openaiActive)
  writeFileSync(
    join(dirs.codex, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-only-api-key' }),
    { mode: 0o600 },
  )
const reserve = createServer()
await new Promise((done) => reserve.listen(0, '127.0.0.1', done))
const port = reserve.address().port
await new Promise((done) => reserve.close(done))
const child = spawn(cli, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
  cwd: dirs.work,
  env: isolated,
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
  const { data: models } = await client.call('model/list', {
    harness: 'codex',
    includeHidden: true,
  })
  assert.ok(
    models.some(({ model }) => model === lunaModel),
    '网关生效清单里有 Luna',
  )
  assert.ok(
    models.some(({ model }) => model === mainModel),
    '同一清单里有非 GPT 模型',
  )
  if (checkMismatch) {
    // 这是单独的上游反例。Litch 的实际命名不能走这个未选中的 provider。
    const before = requests.length
    const { thread } = await client.call('thread/start', {
      harness: 'codex',
      cwd: dirs.work,
      ephemeral: true,
      model: lunaModel,
      modelProvider: 'openai',
    })
    try {
      const rejected = await client.fails('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '检查上游 provider 限制', text_elements: [] }],
      })
      assert.equal(rejected.code, -32600)
      assert.equal(rejected.data.type, 'modelProviderMismatch')
      assert.equal(rejected.data.currentModelProvider, gateway)
      assert.equal(requests.length, before, '上游在发送请求前拒绝')
      console.log('上游反例：指定非当前 provider 返回 modelProviderMismatch，未发出模型请求。')
    } finally {
      await client.call('thread/unsubscribe', { threadId: thread.id })
    }
  }

  for (const [input, expected] of [
    ['检查回环设置', '回环生成标题'],
    [failure, failure],
  ]) {
    // 复制 Litch 模型选择器的两条路径：新建只带 model，或在会话中只改 model。
    const started = await client.call('thread/start', {
      harness: 'codex',
      model: input === failure ? gptModel : mainModel,
      cwd: dirs.work,
    })
    assert.equal(started.modelProvider, active)
    const threadId = started.thread.id
    if (input === failure)
      await client.call('thread/settings/update', { threadId, model: mainModel })
    const completed = client.waitFor(
      (frame) => frame.method === 'turn/completed' && frame.params.threadId === threadId,
      15_000,
    )
    await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: input, text_elements: [] }],
    })
    assert.equal((await completed).params.turn.status, 'completed')
    await device.titles.settled()
    const named = await client.call('thread/read', { threadId, includeTurns: false })
    assert.equal(named.thread.name, expected)
  }
  const main = requests.filter(({ title }) => !title)
  assert.equal(main.length, 2)
  assert.ok(
    main.every(
      ({ provider, model, status }) => provider === active && model === mainModel && status === 200,
    ),
  )
  const naming = requests.filter(({ title }) => title)
  assert.deepEqual(
    naming,
    [200, 400].map((status) => ({
      provider: active,
      title: true,
      model: lunaModel,
      status,
      schema: true,
    })),
  )
  assert.ok(logs.some((line) => line.includes('使用首条消息作为标题')))
  console.log(`非 GPT 主回合和 Luna 命名都在 ${active}；Luna 生成标题，HTTP 400 时使用首条文字。`)
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
