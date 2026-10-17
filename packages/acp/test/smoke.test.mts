import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AcpServer } from '../src/server.mjs'
import { client, text } from './client.mjs'
import { startFakeOpenAi } from './fake-openai.mjs'

// 对着真的 agent 冒烟，默认跳过，手动开：
//   LITCH_SMOKE_OPENCODE=<opencode 的路径>  起 `opencode acp`，模型是回环上的假 OpenAI 兼容模型（fake-openai.mts），
//                                          HOME 和 XDG 目录都是临时的，不碰用户自己的 opencode 数据
//   LITCH_SMOKE_GEMINI=<gemini 的路径>      只做 --runtime-info（initialize 级别的握手），绝不发提示词（会花钱）
// 两边都把 HTTP(S) 代理指向回环上一个没人听的端口：万一 agent 想往外连，连不出去。

const run = promisify(execFile)
const ADAPTER = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
const DEAD_PROXY = 'http://127.0.0.1:9'

async function sandbox(): Promise<{ root: string; cwd: string; env: NodeJS.ProcessEnv }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-acp-smoke-')))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  return {
    root,
    cwd,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  }
}

const opencode = process.env.LITCH_SMOKE_OPENCODE
test('冒烟：真的 opencode acp，回环上的假模型', { skip: !opencode, timeout: 180_000 }, async () => {
  const box = await sandbox()
  const model = await startFakeOpenAi()
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    model: 'fake/fake-model',
    small_model: 'fake/fake-model',
    permission: { bash: 'ask', edit: 'ask' },
    provider: {
      fake: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake',
        options: { baseURL: model.url, apiKey: 'not-a-real-key' },
        models: { 'fake-model': { name: 'Fake Model', tool_call: true } },
      },
    },
  }
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    CHA_ACP_AGENT: 'acp',
    CHA_ACP_CLI: opencode,
    CHA_ACP_ARGS: 'acp',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  }
  const server = new AcpServer(join(box.root, 'home'), env)
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'smoke', version: '0' } })
    const info = await desktop.call('runtime/info', {})
    assert.equal(info.engine, 'acp')
    assert.notEqual(info.cliBuild, 'unknown')
    const { thread } = await desktop.call('thread/start', { cwd: box.cwd })
    const models = await desktop.call('model/list', {})
    assert.ok(
      models.data.some((entry: any) => /fake/.test(entry.id)),
      JSON.stringify(models.data),
    )

    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('say hi'),
    })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id)).turn
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok(
      done.items.some((item: any) => item.type === 'agentMessage' && /冒烟好了/.test(item.text)),
      JSON.stringify(done.items),
    )

    desktop.onRequest(() => ({ decision: 'accept' }))
    const second = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('run-tool please'),
    })
    const ran = (await desktop.until('turn/completed', (p) => p.turn.id === second.turn.id)).turn
    assert.equal(ran.status, 'completed', JSON.stringify(ran.error))
    const command = ran.items.find((item: any) => item.type === 'commandExecution')
    assert.ok(command, JSON.stringify(ran.items))
    assert.match(command.aggregatedOutput ?? '', /smoke/)
    assert.ok(desktop.requests.some((r) => r.method === 'item/commandExecution/requestApproval'))
    assert.ok(model.requests.length >= 3, '模型请求都到了回环上的假模型')

    const listed = await desktop.call('thread/list', {})
    assert.ok(listed.data.some((entry: any) => entry.id === thread.id))
  } finally {
    await server.close()
    await model.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

const gemini = process.env.LITCH_SMOKE_GEMINI
test('冒烟：真的 gemini --acp，只握手', { skip: !gemini, timeout: 120_000 }, async () => {
  const box = await sandbox()
  try {
    const { stdout } = await run(process.execPath, [ADAPTER, '--runtime-info'], {
      env: {
        ...box.env,
        // gemini 是个 node 脚本，要找得到 node
        PATH: `${process.execPath.replace(/\/node$/, '')}:${box.env.PATH}`,
        CHA_ACP_AGENT: 'gemini',
        CHA_GEMINI_CLI: gemini,
        CHA_GEMINI_HOME: join(box.root, 'home'),
        GEMINI_CLI_NO_RELAUNCH: 'true',
      },
      timeout: 90_000,
    })
    const info = JSON.parse(stdout)
    assert.equal(info.engine, 'gemini')
    assert.notEqual(info.cliBuild, 'unknown')
  } finally {
    await rm(box.root, { recursive: true, force: true })
  }
})
