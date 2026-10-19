import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AcpServer } from '../src/server.mjs'
import { client, text } from './client.mjs'
import { startFakeGemini } from './fake-gemini.mjs'
import { startFakeOpenAi } from './fake-openai.mjs'

// 对着真的 agent 冒烟，默认跳过，手动开：
//   LITCH_SMOKE_OPENCODE=<opencode 的路径>  起 `opencode acp`，模型是回环上的假 OpenAI 兼容模型（fake-openai.mts），
//                                          HOME 和 XDG 目录都是临时的，不碰用户自己的 opencode 数据
//                                          （含经 MCP 桥调客户端工具）
//   LITCH_SMOKE_GEMINI=<gemini 的路径>      一条只做 --runtime-info（initialize 级别的握手）；另一条经 MCP 桥调客户端工具，
//                                          模型是回环上的假 Gemini API（fake-gemini.mts，假的密钥），不发真实请求
// 都把 HTTP(S) 代理指向回环上一个没人听的端口：万一 agent 想往外连，连不出去。Gemini CLI 调假模型的那条除外
//（它不看 NO_PROXY），见那条的说明。

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

// 客户端工具的冒烟用的动态工具：一个回声
const ECHO_TOOLS = [
  {
    type: 'namespace',
    name: 'litch_echo',
    description: '测试用的回声。',
    instructions: '要回声时调 litch_echo。',
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
  },
]

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

    // 客户端工具：另一条声明了 litch_echo 的连接建带动态工具的会话，模型经 MCP 桥调回声
    const litch = client(server)
    await litch.call('initialize', {
      clientInfo: { name: 'litch', version: '0' },
      capabilities: {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_echo'] },
      },
    })
    litch.onRequest((request) =>
      request.method === 'item/tool/call'
        ? {
            success: true,
            contentItems: [{ type: 'inputText', text: `回声：${request.params.arguments.text}` }],
          }
        : { decision: 'accept' },
    )
    const tooled = await litch.call('thread/start', { cwd: box.cwd, dynamicTools: ECHO_TOOLS })
    const third = await litch.call('turn/start', {
      threadId: tooled.thread.id,
      input: text('echo-tool please'),
    })
    const echoed = (await litch.until('turn/completed', (p) => p.turn.id === third.turn.id)).turn
    assert.equal(echoed.status, 'completed', JSON.stringify(echoed.error))
    const call = litch.requests.find((r) => r.method === 'item/tool/call')
    assert.ok(call, JSON.stringify(echoed.items))
    assert.deepEqual(call.params.arguments, { text: '冒烟' })
    const dynamic = echoed.items.filter((item: any) => item.type === 'dynamicToolCall')
    assert.equal(dynamic.length, 1, JSON.stringify(echoed.items))
    assert.equal(dynamic[0].id, call.params.callId)
    assert.equal(dynamic[0].success, true)
    const sent = JSON.stringify(model.requests.at(-1)?.messages ?? [])
    assert.ok(sent.includes('回声：冒烟'), '工具结果交回了模型')
    // 命名空间的 instructions 到了模型面前（OpenCode 把 MCP 的 instructions 放进系统提示）
    assert.ok(sent.includes('要回声时调 litch_echo'), '系统提示里有 instructions')
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

// 客户端工具（经 MCP 桥）：真的 gemini --acp，模型是回环上的假 Gemini API（fake-gemini.mts），
// 不用登录、不发真实请求、不花钱。也用 LITCH_SMOKE_GEMINI 开
test('冒烟：真的 gemini --acp 经 MCP 桥调客户端工具，假模型', {
  skip: !gemini,
  timeout: 180_000,
}, async () => {
  const box = await sandbox()
  // Gemini CLI 0.38 给模型的名字是 mcp_litch_echo_echo
  const model = await startFakeGemini((name) => /litch_+echo_echo$/.test(name), { text: '冒烟' })
  await mkdir(join(box.root, '.gemini'), { recursive: true })
  await writeFile(
    join(box.root, '.gemini', 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'gemini-api-key' } },
      privacy: { usageStatisticsEnabled: false },
      general: { disableAutoUpdate: true, disableUpdateNag: true },
    }),
  )
  // 不设代理：Gemini CLI 不看 NO_PROXY，设了连回环上的假模型也走代理。外连靠假的密钥和关掉的统计挡着
  const { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, ...direct } = box.env
  const server = new AcpServer(join(box.root, 'home'), {
    ...direct,
    PATH: `${process.execPath.replace(/\/node$/, '')}:${box.env.PATH}`,
    CHA_ACP_AGENT: 'gemini',
    CHA_GEMINI_CLI: gemini,
    GEMINI_CLI_NO_RELAUNCH: 'true',
    GEMINI_API_KEY: 'fake-key',
    GOOGLE_GEMINI_BASE_URL: model.url,
  })
  const desktop = client(server)
  try {
    await desktop.call('initialize', {
      clientInfo: { name: 'litch', version: '0' },
      capabilities: {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_echo'] },
      },
    })
    desktop.onRequest((request) =>
      request.method === 'item/tool/call'
        ? {
            success: true,
            contentItems: [{ type: 'inputText', text: `回声：${request.params.arguments.text}` }],
          }
        : { decision: 'accept' },
    )
    const { thread } = await desktop.call('thread/start', {
      cwd: box.cwd,
      dynamicTools: ECHO_TOOLS,
    })
    const { turn: started } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('调一下回声'),
    })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === started.id)).turn
    const call = desktop.requests.find((r) => r.method === 'item/tool/call')
    assert.ok(call, '收到了 item/tool/call')
    assert.deepEqual(
      { namespace: call.params.namespace, tool: call.params.tool, args: call.params.arguments },
      { namespace: 'litch_echo', tool: 'echo', args: { text: '冒烟' } },
    )
    const tools = done.items.filter((item: any) => item.type === 'dynamicToolCall')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].id, call.params.callId)
    assert.equal(tools[0].success, true)
    // 用户那里没有审批卡（Gemini CLI 对 MCP 工具要问权限，入口替它允许了这一次）
    assert.ok(!desktop.requests.some((r) => /requestApproval$/.test(r.method)))
    // 工具结果交回了模型
    const answered = JSON.stringify(model.requests.at(-1)?.contents ?? [])
    assert.ok(answered.includes('回声：冒烟'), answered.slice(-500))
    // 命名空间的 instructions 到了模型面前（Gemini CLI 把 MCP 的 instructions 拼进系统提示）
    const system = JSON.stringify(model.requests[0]?.systemInstruction ?? '')
    assert.ok(system.includes('要回声时调 litch_echo'), '系统提示里有 instructions')
  } finally {
    await server.close()
    await model.close()
    await rm(box.root, { recursive: true, force: true })
  }
})
