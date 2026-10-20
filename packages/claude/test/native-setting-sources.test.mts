import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 真实 CLI 上的三个开关：CHA_CLAUDE_SETTING_SOURCES（读哪几层 Claude Code 设置）、
// CHA_CLAUDE_PLANS_LOCATION（计划文件放哪）、CHA_CLAUDE_THREAD_ID_HEADER（模型请求带不带线程号）。

const MEMORY_MARKER = 'PROJECT-MEMORY-MARKER-7f3a'

function promptText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(promptText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(promptText).join('\n')
  return ''
}

function toolResultText(request: ModelRequest, id: string): string {
  const block = request.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((b: any) => b.type === 'tool_result' && b.tool_use_id === id)
  assert.ok(block, `缺少工具结果 ${id}`)
  return promptText(block.content)
}

/** 工作区里放齐 Claude Code 的项目级配置：settings.json（env、hooks）、.mcp.json、CLAUDE.md */
async function projectWorkspace(home: string): Promise<{ workspace: string; hookMarker: string }> {
  const workspace = join(home, 'ws')
  const hookMarker = join(home, 'project-hook-ran')
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    join(workspace, '.claude', 'settings.json'),
    JSON.stringify({
      env: { CHA_PROBE_PROJECT_ENV: 'from-project' },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch '${hookMarker}'` }] }],
      },
    }),
  )
  await writeFile(
    join(workspace, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        probe: {
          command: process.execPath,
          args: [resolve('packages/claude/test/fixtures/mcp-stdio-server.mjs')],
        },
      },
    }),
  )
  await writeFile(join(workspace, 'CLAUDE.md'), `${MEMORY_MARKER}\n`)
  // 项目 MCP 要先批准才连；批准写在用户级设置里，只读 user 时也在，区别只在读不读 .mcp.json
  await mkdir(join(home, 'claude'), { recursive: true })
  await writeFile(
    join(home, 'claude', 'settings.json'),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  )
  return { workspace, hookMarker }
}

for (const [label, sources, projectLoaded] of [
  ['默认（三层都读）', null, true],
  ['只读 user', 'user', false],
] as const)
  test(`SETTING-SOURCES-001：${label}时工作区的 settings.json、.mcp.json、CLAUDE.md ${projectLoaded ? '都生效' : '都不生效'}`, {
    timeout: 100_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-setting-sources-'))
    const model = new MockLLM()
    const { workspace, hookMarker } = await projectWorkspace(home)
    const client = await ProtocolClient.start(
      home,
      await model.start(),
      false,
      'api-key',
      sources ? { CHA_CLAUDE_SETTING_SOURCES: sources } : {},
    )
    try {
      let tools: string[] = []
      let sawMemory = false
      model.enqueue((request) => {
        tools = (request.tools ?? []).map((tool: any) => String(tool.name))
        sawMemory = promptText([request.system, request.messages]).includes(MEMORY_MARKER)
        return [
          {
            type: 'tool_use',
            id: 'toolu_env',
            name: 'Bash',
            input: { command: 'echo "probe=${CHA_PROBE_PROJECT_ENV:-unset}"' },
          },
        ]
      })
      let envLine = ''
      model.enqueue((request) => {
        envLine = toolResultText(request, 'toolu_env')
        return [{ type: 'text', text: 'DONE' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: workspace,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '看看环境' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      const hookRan = await access(hookMarker).then(
        () => true,
        () => false,
      )
      assert.equal(hookRan, projectLoaded, '工作区 settings.json 里的 hooks')
      assert.match(envLine, projectLoaded ? /probe=from-project/ : /probe=unset/)
      assert.equal(tools.includes('mcp__probe__echo'), projectLoaded, `.mcp.json：${tools}`)
      assert.equal(sawMemory, projectLoaded, '工作区的 CLAUDE.md')
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

test('SETTING-SOURCES-002：CHA_CLAUDE_SETTING_SOURCES 给了认不出的值时入口起不来', {
  timeout: 30_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-setting-sources-bad-'))
  const model = new MockLLM()
  try {
    await assert.rejects(
      ProtocolClient.start(home, await model.start(), false, 'api-key', {
        CHA_CLAUDE_SETTING_SOURCES: 'user,workspace',
      }),
      /CHA_CLAUDE_SETTING_SOURCES 无效/,
    )
  } finally {
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PLANS-LOCATION-001：CHA_CLAUDE_PLANS_LOCATION=config 时计划文件放进 Claude Code 自己的配置目录，工作区里不留东西', {
  timeout: 100_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-plans-config-'))
  const model = new MockLLM()
  const workspace = join(home, 'ws')
  await mkdir(workspace, { recursive: true })
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
    CHA_CLAUDE_PLANS_LOCATION: 'config',
  })
  try {
    let planPath = ''
    model.enqueue(() => [{ type: 'tool_use', id: 'toolu_enter', name: 'EnterPlanMode', input: {} }])
    model.enqueue((request) => {
      const location = /create your plan at ([^\n]+?) using the Write tool/.exec(
        promptText(request.messages),
      )
      assert.ok(location, 'CLI 必须向模型提供真实计划路径')
      planPath = location[1]!
      return [
        {
          type: 'tool_use',
          id: 'toolu_plan_file',
          name: 'Write',
          input: { file_path: planPath, content: '# 可执行计划\n1. 写入结果' },
        },
      ]
    })
    model.enqueue((request) => {
      assert.doesNotMatch(toolResultText(request, 'toolu_plan_file'), /超出|denied|拒绝/)
      return [{ type: 'text', text: '请确认计划' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '先进入计划模式' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
    assert.equal(await realpath(dirname(planPath)), join(await realpath(home), 'claude', 'plans'))
    assert.match(await readFile(planPath, 'utf8'), /可执行计划/)
    await assert.rejects(access(join(workspace, '.claude')), '工作区里不建 .claude')
    assert.doesNotMatch(client.stderr, /plansDirectory must be within project root/)
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.ok(
      history.thread.turns[0].items.some(
        (i: any) => i.type === 'plan' && i.text.includes('可执行计划'),
      ),
      '计划文本照样交给客户端',
    )
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const [label, enabled] of [
  ['默认关', false],
  ['开着', true],
] as const)
  test(`THREAD-ID-HEADER-001：CHA_CLAUDE_THREAD_ID_HEADER ${label}时模型请求${enabled ? '带上线程号、保留原有的自定义头' : '不多带任何头'}`, {
    timeout: 100_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-thread-id-header-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
      ANTHROPIC_CUSTOM_HEADERS: 'x-user-header: keep\nthread-id: stale',
      ...(enabled ? { CHA_CLAUDE_THREAD_ID_HEADER: '1' } : {}),
    })
    try {
      const seen: Array<Record<string, unknown>> = []
      model.enqueue((_request, headers) => {
        seen.push({ ...headers })
        return [{ type: 'text', text: 'DONE' }]
      })
      const { thread } = await client.request('thread/start', { cwd: home })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '你好' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      const headers = seen[0]!
      assert.equal(headers['x-user-header'], 'keep')
      // 关着时入口不碰 ANTHROPIC_CUSTOM_HEADERS，用户自己给的头原样发出去
      assert.equal(headers['thread-id'], enabled ? thread.id : 'stale')
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
