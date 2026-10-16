import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalMcp } from './fixtures/mcp-http.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('MCP-001：真实 SDK HTTP MCP、环境凭据引用、工具副作用与结果', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-'))
  const file = join(home, 'mcp-effect.txt')
  const mcp = new LocalMcp(() => writeFile(file, 'real-mcp-effect'))
  const url = await mcp.start()
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    model.enqueue((request) => {
      const tool = request.tools.find((tool: any) => tool.name === 'mcp__fixture__touch_fixture')
      assert.ok(tool, '真实 MCP 工具必须进入模型请求')
      return [{ type: 'tool_use', id: 'toolu_mcp', name: tool.name, input: {} }]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /MCP_FILE_WRITTEN/)
      return [{ type: 'text', text: 'MCP_DONE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: {
        mcp_servers: {
          fixture: {
            url,
            bearer_token_env_var: 'ANTHROPIC_API_KEY',
            http_headers: { 'X-Runtime': 'claude-fixture' },
            startup_timeout_sec: 10,
          },
        },
      },
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Run the MCP fixture' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(await readFile(file, 'utf8'), 'real-mcp-effect')
    assert.equal(mcp.calls, 1)
    assert.deepEqual(mcp.errors, [])
    model.enqueue((request) => {
      assert.ok(
        request.tools.every((tool: any) => !tool.name.startsWith('mcp__fixture__')),
        'MCP 配置不能泄漏到同目录的其他线程',
      )
      return [{ type: 'text', text: 'ISOLATED' }]
    })
    const other = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const otherTurn = await client.request('turn/start', {
      threadId: other.thread.id,
      input: [{ type: 'text', text: 'No MCP on this thread' }],
    })
    assert.equal((await client.completed(otherTurn.turn.id)).status, 'completed')
    assert.equal(mcp.calls, 1)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await mcp.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('MCP-002：隔离配置中的 Skill 与项目指令实际进入模型上下文', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-skills-'))
  const project = join(home, 'project')
  await mkdir(project)
  await writeFile(
    join(project, 'CLAUDE.md'),
    'PROJECT_INSTRUCTION_FIXTURE: Verify the fixture effect.',
  )
  const skill = join(home, 'claude', 'skills', 'fixture')
  await mkdir(skill, { recursive: true })
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: fixture\ndescription: SKILL_DESCRIPTION_FIXTURE\n---\nSKILL_BODY_FIXTURE: Report the fixture result.\n',
  )
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    model.enqueue((request) => {
      assert.match(JSON.stringify(request), /PROJECT_INSTRUCTION_FIXTURE/)
      assert.match(JSON.stringify(request), /SKILL_DESCRIPTION_FIXTURE/)
      return [{ type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'fixture' } }]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /SKILL_BODY_FIXTURE/)
      return [{ type: 'text', text: 'SKILL_DONE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: project,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Use the fixture skill' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
