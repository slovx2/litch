import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-pi-runtime-'))
const agentDir = join(root, 'agent')
await mkdir(agentDir)
process.env.PI_CODING_AGENT_DIR = agentDir
// 验证随适配器分发的插件与"用户安装的 Pi"的组合：默认是开发依赖里的基线，PI_CLI 可改测其他版本。
await import('../dist/pi/test/setup.mjs')
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
  '../dist/pi/src/sdk.mjs'
)
const replies = []
const requests = []
const failures = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push(body)
  const next = replies.shift()
  if (!next) {
    failures.push('unexpected request')
    res.writeHead(500).end()
    return
  }
  const reply = typeof next === 'function' ? await next(body) : next
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  const base = { id: 'gate', object: 'chat.completion.chunk', created: 1, model: body.model }
  const calls = reply.tools?.map((t, index) => ({
    index,
    id: `call_${requests.length}_${index}`,
    type: 'function',
    function: { name: t.name, arguments: JSON.stringify(t.args) },
  }))
  event({
    ...base,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          ...(calls ? { tool_calls: calls } : { content: reply.text ?? 'ok' }),
        },
        finish_reason: null,
      },
    ],
  })
  event({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  res.end('data: [DONE]\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
await writeFile(
  join(agentDir, 'models.json'),
  JSON.stringify({
    providers: {
      gate: {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'local-test-key',
        models: [
          {
            id: 'gate',
            name: 'Gate',
            reasoning: false,
            input: ['text'],
            contextWindow: 32000,
            maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
)
const errors = []
const dialogs = []
const notifications = []
const noop = () => {}
const ui = {
  select: async (title, options) => {
    dialogs.push(title)
    return title.includes('Architecture') ? options[0] : undefined
  },
  confirm: async () => true,
  input: async () => 'answer',
  editor: async () => 'answer',
  notify: (message, type) => {
    notifications.push({ message, type })
    console.log('notify', type, message)
  },
  onTerminalInput: () => noop,
  setStatus: noop,
  setWorkingMessage: noop,
  setWorkingVisible: noop,
  setWorkingIndicator: noop,
  setHiddenThinkingLabel: noop,
  setWidget: noop,
  setFooter: noop,
  setHeader: noop,
  setTitle: noop,
  custom: async () => {
    throw new Error('TUI custom forbidden in RPC')
  },
  pasteToEditor: noop,
  setEditorText: noop,
  getEditorText: () => '',
  addAutocompleteProvider: noop,
  setEditorComponent: noop,
  getEditorComponent: () => undefined,
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: true }),
  getToolsExpanded: () => false,
  setToolsExpanded: noop,
  theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
}
let session
try {
  await mkdir(join(root, '.pi', 'agents'), { recursive: true })
  await writeFile(
    join(root, '.pi', 'agents', 'Explore.md'),
    '---\nname: Explore\ndescription: Project Explore override\n---\nPROJECT_AGENT_CWD_SENTINEL: respect the current session project.\n',
  )
  await mkdir(join(agentDir, 'agents'), { recursive: true })
  await writeFile(
    join(agentDir, 'agents', 'Explore.md'),
    '---\ndescription: Global Explore\n---\nGLOBAL_AGENT_SENTINEL\n',
  )
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'gate',
    defaultModel: 'gate',
    retry: { enabled: false },
  })
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      join(process.cwd(), 'node_modules/@narumitw/pi-plan-mode/dist/index.ts'),
      join(process.cwd(), 'node_modules/@gotgenes/pi-subagents/src/index.ts'),
    ],
  })
  await loader.reload()
  assert.deepEqual(loader.getExtensions().errors, [])
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(root, join(root, 'sessions')),
  })
  session = result.session
  session.subscribe((e) => {
    if (e.type === 'tool_execution_end') console.log('tool completed:', e.toolName)
    if (e.type === 'agent_settled') console.log('settled')
  })
  const unsupported = async () => {
    throw new Error('unused command action')
  }
  await session.bindExtensions({
    mode: 'rpc',
    uiContext: ui,
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: unsupported,
      fork: unsupported,
      navigateTree: unsupported,
      switchSession: unsupported,
      reload: unsupported,
    },
    onError: (e) => {
      errors.push(e)
      console.error(JSON.stringify(e))
    },
  })
  await session.prompt('/plan start')
  const planState = () =>
    session.sessionManager
      .getEntries()
      .filter((e) => e.type === 'custom' && e.customType === 'plan-mode-state')
      .at(-1)?.data
  console.log('Plan entered')
  assert.equal(planState()?.enabled, true)
  replies.push({
    tools: [{ name: 'plan_mode_complete', args: { plan: '# Plan\nImplement the local test.' } }],
  })
  await session.prompt('Prepare a plan.')
  console.log('Plan ready')
  assert.match(planState()?.latestPlan ?? '', /Implement/)
  replies.push({ text: 'Implementation done' })
  const beforeImplement = requests.length
  const implemented = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('实施未触发 agent_settled')), 10000)
    const off = session.subscribe((e) => {
      if (e.type === 'agent_settled') {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
  await session.prompt('/plan implement')
  await implemented
  assert.equal(requests.length, beforeImplement + 1)
  await session.prompt('/plan exit')
  assert.equal(planState()?.enabled, false)
  console.log('PLAN PASS')
  const beforeChild = requests.length
  replies.push(
    {
      tools: [
        {
          name: 'subagent',
          args: {
            subagent_type: 'Explore',
            prompt: 'Return child result.',
            description: 'Child version gate',
            model: 'gate/gate',
            run_in_background: false,
          },
        },
      ],
    },
    { text: 'Child result' },
    { text: 'Parent done' },
  )
  await session.prompt('Delegate one task.')
  assert.equal(replies.length, 0, '子代理必须真实调用模型')
  assert.deepEqual(errors, [])
  assert.deepEqual(failures, [])
  console.log('SUBAGENT PASS', requests.length)
  assert.ok(
    JSON.stringify(requests[beforeChild + 1].messages).includes('GLOBAL_AGENT_SENTINEL'),
    '子代理必须保留原生全局代理配置；项目级定义不在适配范围',
  )
} finally {
  await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  session?.dispose()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
