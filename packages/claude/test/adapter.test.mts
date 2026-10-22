import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import test, { after } from 'node:test'
import WebSocket from 'ws'
import type { ProviderLoopConfigProjectionResult } from '../src/provider-loop-config.mjs'
import { SessionStore } from '../src/store.mjs'
import { isolatedEnv } from './fixtures/isolated-env.mjs'
import { LocalMcp } from './fixtures/mcp-http.mjs'

const adapter = resolve('packages/claude/dist/claude/src/adapter.mjs')
const shim = resolve('scripts/codex-shim')

// 用例超时或中途抛错时不能留下被测进程：它们会让测试文件永远不退出。
const spawned = new Set<ChildProcess>()
const spawn = ((...args: any[]) => {
  const child = (spawnProcess as any)(...args) as ChildProcess
  spawned.add(child)
  child.once('exit', () => spawned.delete(child))
  return child
}) as typeof spawnProcess
after(() => {
  for (const child of spawned) child.kill('SIGKILL')
})

// 被测进程不再输出时用例应当失败，而不是无限挂起。
const READ_TIMEOUT_MS = 60_000
const RESPONSE_TIMEOUT_MS = 120_000

test('server dispatch covers current Codex app-server client method surface', async () => {
  const source = await readFile(resolve('packages/claude/src/server.mts'), 'utf8')
  const methods = [
    'initialize',
    'thread/start',
    'thread/resume',
    'thread/fork',
    'thread/archive',
    'thread/unsubscribe',
    'thread/increment_elicitation',
    'thread/decrement_elicitation',
    'thread/name/set',
    'thread/goal/set',
    'thread/goal/get',
    'thread/goal/clear',
    'thread/metadata/update',
    'thread/section/move',
    'threadSection/list',
    'threadSection/create',
    'threadSection/update',
    'threadSection/delete',
    'thread/settings/update',
    'thread/memoryMode/set',
    'memory/reset',
    'thread/unarchive',
    'thread/compact/start',
    'thread/shellCommand',
    'thread/backgroundTerminals/clean',
    'thread/rollback',
    'thread/list',
    'thread/loaded/list',
    'thread/read',
    'thread/turns/list',
    'thread/turns/items/list',
    'thread/inject_items',
    'skills/list',
    'hooks/list',
    'marketplace/add',
    'marketplace/remove',
    'marketplace/upgrade',
    'plugin/list',
    'plugin/read',
    'plugin/skill/read',
    'plugin/share/save',
    'plugin/share/updateTargets',
    'plugin/share/list',
    'plugin/share/delete',
    'app/list',
    'fs/readFile',
    'fs/writeFile',
    'fs/createDirectory',
    'fs/getMetadata',
    'fs/readDirectory',
    'fs/remove',
    'fs/copy',
    'fs/watch',
    'fs/unwatch',
    'skills/config/write',
    'plugin/install',
    'plugin/uninstall',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'thread/realtime/start',
    'thread/realtime/appendAudio',
    'thread/realtime/appendText',
    'thread/realtime/stop',
    'thread/realtime/listVoices',
    'review/start',
    'model/list',
    'modelProvider/capabilities/read',
    'experimentalFeature/list',
    'permissionProfile/list',
    'experimentalFeature/enablement/set',
    'collaborationMode/list',
    'mock/experimentalMethod',
    'mcpServer/oauth/login',
    'config/mcpServer/reload',
    'mcpServerStatus/list',
    'mcpServer/resource/read',
    'mcpServer/tool/call',
    'windowsSandbox/setupStart',
    'windowsSandbox/readiness',
    'account/login/start',
    'account/login/cancel',
    'account/logout',
    'account/sendAddCreditsNudgeEmail',
    'feedback/upload',
    'command/exec',
    'command/exec/write',
    'command/exec/terminate',
    'command/exec/resize',
    'process/spawn',
    'process/writeStdin',
    'process/kill',
    'process/resizePty',
    'config/read',
    'externalAgentConfig/detect',
    'config/value/write',
    'config/batchWrite',
    'configRequirements/read',
    'account/read',
    'getConversationSummary',
    'gitDiffToRemote',
    'getAuthStatus',
    'fuzzyFileSearch',
    'fuzzyFileSearch/sessionStart',
    'fuzzyFileSearch/sessionUpdate',
    'fuzzyFileSearch/sessionStop',
    'thread/backgroundTerminals/list',
    'thread/backgroundTerminals/terminate',
    'thread/backgroundTerminals/clean',
  ]
  const missing = methods.filter((method) => !source.includes(`case '${method}':`))
  assert.deepEqual(missing, [])
})

test('stdio initialize -> thread/start -> turn/start streams mock response', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    const init = await reader.nextResponse(1)
    assert.equal(init.result.platformFamily, process.platform === 'win32' ? 'windows' : 'unix')

    proc.stdin.write(
      json({ id: 4, method: 'permissionProfile/list', params: { limit: 100, cursor: null } }),
    )
    const permissionProfiles = await reader.nextResponse(4)
    assert.deepEqual(permissionProfiles.result.data, [
      { id: ':read-only', description: null, allowed: true },
      { id: ':workspace', description: null, allowed: true },
      { id: ':danger-full-access', description: null, allowed: true },
    ])
    assert.equal(permissionProfiles.result.nextCursor, null)

    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id
    assert.equal(start.result.modelProvider, 'claude-code')
    assert.equal(start.result.thread.isPinned, false)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    const turnStart = await reader.nextResponse(3)
    assert.equal(turnStart.result.turn.status, 'inProgress')

    const deltas: string[] = []
    let sawAgentCompleted = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') deltas.push(message.params.delta)
      if (message.method === 'item/completed' && message.params.item.type === 'agentMessage')
        sawAgentCompleted = true
      if (message.method === 'turn/completed') break
    }
    assert.match(deltas.join(''), /Claude Code adapter mock response/)
    assert.equal(sawAgentCompleted, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('permission profile selection applies full access without legacy sandbox fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'codex-test', version: '26.818' }, capabilities: null },
      }),
    )
    await reader.nextResponse(1)
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), permissions: ':danger-full-access' },
      }),
    )
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id
    assert.equal(start.result.approvalPolicy, 'never')
    assert.equal(start.result.sandbox.type, 'dangerFullAccess')
    assert.deepEqual(start.result.activePermissionProfile, {
      id: ':danger-full-access',
      extends: null,
    })
    assert.equal(start.result.permissions, ':danger-full-access')

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
          permissions: ':danger-full-access',
        },
      }),
    )
    await reader.nextResponse(3)
    let sawApprovalRequest = false
    let sawCommandOutput = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/commandExecution/requestApproval') sawApprovalRequest = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawCommandOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawApprovalRequest, false)
    assert.equal(sawCommandOutput, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('run registry records thread and turn lifecycle without raw prompt or response text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const runLog = join(home, 'runs.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_RUN_LOG: runLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    await reader.nextResponse(1)
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'secret prompt token=secret123456789', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(3)
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    const logText = await readFile(runLog, 'utf8')
    const entries = logText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.deepEqual(
      entries.map((entry) => entry.event),
      ['thread.started', 'turn.started', 'turn.completed'],
    )
    assert.equal(logText.includes('secret prompt'), false)
    assert.equal(logText.includes('Claude Code adapter mock response'), false)
    assert.equal(
      entries.every((entry) => entry.threadId === threadId),
      true,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('primary turn lifecycle keeps lightweight notLoaded envelopes', async () => {
  // turn/start and turn/started are metadata-only. Primary-thread completion
  // remains item-stream driven here; subagent completion is covered separately
  // because its terminal envelope must carry the final response for review UI.
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    await reader.nextResponse(1)
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          clientUserMessageId: 'client-message-1',
          input: [{ type: 'text', text: 'hello', text_elements: [] }],
        },
      }),
    )
    const turnStart = await reader.nextResponse(3)
    assert.deepEqual(turnStart.result.turn.items, [], 'turn/start response items must be empty')
    assert.equal(turnStart.result.turn.itemsView, 'notLoaded')

    let started = null
    let completed = null
    const userMessageEvents: any[] = []
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/started') started = message.params.turn
      if (
        (message.method === 'item/started' || message.method === 'item/completed') &&
        message.params.item?.type === 'userMessage'
      ) {
        userMessageEvents.push(message)
      }
      if (message.method === 'turn/completed') {
        completed = message.params.turn
        break
      }
    }
    assert.ok(started, 'expected turn/started')
    assert.deepEqual(started.items, [], 'turn/started items must be empty')
    assert.equal(started.itemsView, 'notLoaded')
    assert.ok(completed, 'expected turn/completed')
    assert.deepEqual(completed.items, [], 'turn/completed items must be empty')
    assert.equal(completed.itemsView, 'notLoaded')
    // Lifecycle turn envelopes must not carry non-schema fields.
    assert.ok(!('apiDurationMs' in completed), 'Turn schema has no apiDurationMs')
    assert.ok(!('costUsd' in completed), 'Turn schema has no costUsd')
    // 和上游一样：用户消息作为条目发出来（开始、完成各一次），带着客户端给的 clientId
    assert.deepEqual(
      userMessageEvents.map((message) => message.method),
      ['item/started', 'item/completed'],
    )
    for (const message of userMessageEvents) {
      assert.equal(message.params.turnId, turnStart.result.turn.id)
      assert.equal(message.params.item.clientId, 'client-message-1')
      assert.deepEqual(message.params.item.content, [
        { type: 'text', text: 'hello', text_elements: [] },
      ])
    }
    assert.equal(userMessageEvents[0].params.item.id, userMessageEvents[1].params.item.id)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/turns/list honors default summary and explicit itemsView', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    proc.stdin.write(json({ id: 3, method: 'thread/turns/list', params: { threadId } }))
    const summary = await reader.nextResponse(3)
    const summaryTurn = summary.result.data[0]
    assert.equal(summaryTurn.itemsView, 'summary')
    assert.deepEqual(
      summaryTurn.items.map((item: Record<string, unknown>) => item.type),
      ['userMessage', 'agentMessage'],
    )

    proc.stdin.write(
      json({ id: 4, method: 'thread/turns/list', params: { threadId, itemsView: 'notLoaded' } }),
    )
    const notLoaded = await reader.nextResponse(4)
    assert.equal(notLoaded.result.data[0].itemsView, 'notLoaded')
    assert.deepEqual(notLoaded.result.data[0].items, [])

    proc.stdin.write(
      json({ id: 5, method: 'thread/turns/list', params: { threadId, itemsView: 'full' } }),
    )
    const full = await reader.nextResponse(5)
    const fullTurn = full.result.data[0]
    assert.equal(fullTurn.itemsView, 'full')
    assert.ok(fullTurn.items.length >= summaryTurn.items.length)
    assert.ok(fullTurn.items.some((item: Record<string, unknown>) => item.type === 'userMessage'))
    assert.ok(fullTurn.items.some((item: Record<string, unknown>) => item.type === 'agentMessage'))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('MCP 服务无法启动时通知失败，状态查询不能返回空成功', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      CHA_CLAUDE_MCP_SERVERS: JSON.stringify({
        github: { type: 'stdio', command: 'github-mcp' },
      }),
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    // Boot-time startup notification: correct method + valid McpServerStartupState.
    // The boot notifications are flushed via queueMicrotask, so they can land
    // before the initialize response — scan every message rather than reading
    // (and discarding) the response first.
    let startup = null
    let sawInit = false
    for (let i = 0; i < 50; i += 1) {
      const message = await reader.next()
      if (
        message.method === 'mcpServer/startupStatus/updated' &&
        message.params.name === 'github' &&
        message.params.status === 'failed'
      )
        startup = message.params
      if (message.id === 1 && message.method == null) sawInit = true
      if (startup && sawInit) break
    }
    assert.ok(startup, 'expected mcpServer/startupStatus/updated notification')
    assert.equal(startup.name, 'github')
    assert.equal(startup.status, 'failed')
    assert.match(startup.error, /ENOENT/)

    proc.stdin.write(json({ id: 2, method: 'mcpServerStatus/list', params: {} }))
    const list = await reader.nextResponse(2)
    assert.equal(list.error.code, -32001)
    assert.ok(!('result' in list))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('启动探测遇到失败的 MCP 服务后继续探测其余服务', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const fixture = resolve('packages/claude/test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      // 启动失败的服务排在前面：它不能让排在后面的服务没有状态。
      CHA_CLAUDE_MCP_SERVERS: JSON.stringify({
        broken: { type: 'stdio', command: 'missing-mcp-command' },
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    const seen = new Map<string, string>()
    while (seen.get('broken') !== 'failed' || seen.get('fixture') !== 'ready') {
      const message = await reader.next(15_000)
      if (message.method === 'mcpServer/startupStatus/updated')
        seen.set(message.params.name, message.params.status)
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('MCP 服务没有实现资源模板目录时，状态查询仍列出工具与资源', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const fixture = resolve('packages/claude/test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      CHA_CLAUDE_MCP_SERVERS: JSON.stringify({
        fixture: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture, '--no-resource-templates'],
        },
      }),
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1, 30_000)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    const entry = response.result.data[0]
    assert.equal(entry.name, 'fixture')
    assert.equal(entry.tools.echo.name, 'echo')
    assert.equal(entry.resources[0].uri, 'fixture://resource')
    assert.deepEqual(entry.resourceTemplates, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude 入口拒绝 GPT 模型，恢复不会改变引擎', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    // Claude model → claude backend.
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const claudeStart = await reader.nextResponse(1)
    assert.equal(claudeStart.result.model, 'sonnet')

    // Codex/OpenAI model → codex backend. The detection lives in
    // thread/start (isCodexOpenAiModel) so the choice round-trips through
    // thread/resume and survives a daemon restart.
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'gpt-5.4-mini' },
      }),
    )
    const codexStart = await reader.nextResponse(2)
    assert.equal(codexStart.error.code, -32602)
    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/resume',
        params: { threadId: claudeStart.result.thread.id, model: 'gpt-5.4-mini' },
      }),
    )
    assert.equal((await reader.nextResponse(3)).error.code, -32602)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('model/list follows the native Claude catalog with Codex-safe reasoning efforts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      // 默认模型写在 Claude 的 settings.json 里：用用例自己的配置目录，不和同文件的别的用例共用
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MODELS: '',
      CHA_CLAUDE_MODEL_ALIASES: '',
      CHA_CLAUDE_DEFAULT_MODEL: 'opus',
      CHA_CLAUDE_DEFAULT_EFFORT: 'xhigh',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    assert.equal(config.result.config.model, 'opus')
    assert.equal(config.result.config.model_reasoning_effort, 'xhigh')
    assert.equal(config.result.config.model_provider, 'claude-code')
    assert.equal(config.result.config.model_providers['claude-code'].name, 'Claude Code')
    assert.equal(config.result.config.model_providers['claude-code'].requires_openai_auth, false)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult
    assert.deepEqual(
      providerLoopConfig.providers.map((provider) => provider.id),
      ['claude-code', 'codex'],
    )
    assert.deepEqual(providerLoopConfig.issues, [])
    const claudeCodeProvider = providerLoopConfig.providers.find(
      (provider) => provider.id === 'claude-code',
    )
    assert.ok(claudeCodeProvider)
    assert.equal(claudeCodeProvider.loopId, 'native-claude-code-sdk')
    assert.equal(claudeCodeProvider.providerFamily, 'anthropic')
    assert.equal(claudeCodeProvider.status, 'stable')
    assert.equal(claudeCodeProvider.supportsSteer, true)
    const allowedCredentialSources = new Set<string>(claudeCodeProvider.allowedCredentialSources)
    assert.equal(allowedCredentialSources.has('user-api-key'), true)
    assert.equal(allowedCredentialSources.has('personal-session'), false)
    assert.equal(allowedCredentialSources.has('browser-cookie'), false)

    proc.stdin.write(json({ id: 7, method: 'account/read', params: {} }))
    const account = await reader.nextResponse(7)
    assert.equal(account.result.account, null)
    assert.equal(account.result.requiresOpenaiAuth, false)

    proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
    const models = await reader.nextResponse(2)
    const ids = models.result.data.map((model: any) => model.id)
    // 配置的默认模型 opus 不是目录行：清单末尾给它补一行，新会话报的模型在清单里找得到。
    assert.deepEqual(ids, [
      'default',
      'opus[1m]',
      'claude-fable-5-1',
      'sonnet',
      'sonnet[1m]',
      'haiku',
      'opus',
    ])
    const fable = models.result.data.find((model: any) => model.id === 'claude-fable-5-1')
    assert.equal(fable.displayName, 'Fable 5.1')
    assert.match(fable.description, /Fable 5\.1/)
    // 默认标记落在补的那一行上，原生 default 行不再标默认。
    const nativeDefault = models.result.data.find((model: any) => model.id === 'default')
    assert.equal(nativeDefault.displayName, 'Default · Opus 5.5 (1M context)')
    assert.equal(nativeDefault.isDefault, false)
    assert.deepEqual(models.result.data.map((model: any) => model.displayName).slice(1), [
      'Opus 5.5 (1M context)',
      'Fable 5.1',
      'Sonnet 5',
      'Sonnet 5 (1M context)',
      'Haiku 4.5',
      'Claude Opus',
    ])
    const defaultRow = models.result.data.find((model: any) => model.id === 'opus')
    assert.equal(defaultRow.isDefault, true)
    assert.deepEqual(defaultRow.serviceTiers, [])
    assert.equal(defaultRow.defaultServiceTier, null)
    assert.equal(defaultRow.modelSpecialty, null)
    assert.equal(models.result.data.filter((model: any) => model.isDefault === true).length, 1)
    assert.deepEqual(
      defaultRow.supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort),
      ['low', 'medium', 'high', 'xhigh'],
    )

    proc.stdin.write(
      json({
        id: 3,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'haiku', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await reader.nextResponse(3)
    proc.stdin.write(json({ id: 4, method: 'config/read', params: {} }))
    const updatedConfig = await reader.nextResponse(4)
    assert.equal(updatedConfig.result.config.model, 'haiku')
    assert.equal(updatedConfig.result.config.model_reasoning_effort, 'low')

    proc.stdin.write(
      json({
        id: 5,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'runtime-agent-http', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    const rejectedConfig = await reader.nextResponse(5)
    assert.equal(rejectedConfig.error.code, -32602)
    proc.stdin.write(json({ id: 6, method: 'config/read', params: {} }))
    const repairedConfig = await reader.nextResponse(6)
    assert.equal(repairedConfig.result.config.model, 'haiku')
    assert.equal(repairedConfig.result.config.model_reasoning_effort, 'low')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/read exposes sanitized provider loop selection over stdio', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_PROVIDER: 'codex',
      CHA_CLAUDE_AGENT_LOOP: 'codex-jsonl-proxy',
      CHA_CLAUDE_RUNTIME_TYPE: '',
      CHA_CLAUDE_RUNTIME: '',
      CHA_CLAUDE_BACKEND: '',
      CHA_CLAUDE_MOCK: '',
      CHA_CLAUDE_DISABLE_CODEX_PROXY: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult

    assert.deepEqual(
      providerLoopConfig.providers.map((provider) => provider.id),
      ['claude-code', 'codex'],
    )
    assert.deepEqual(providerLoopConfig.selection, {
      providerId: 'codex',
      loopId: 'codex-jsonl-proxy',
      runtimeType: 'codex-proxy',
      source: 'environment',
    })
    assert.deepEqual(providerLoopConfig.issues, [])
    assert.deepEqual(Object.keys(providerLoopConfig.providers[0] ?? {}).sort(), [
      'allowedCredentialSources',
      'approvalFidelity',
      'complianceNotes',
      'displayName',
      'eventFidelity',
      'gatewayPolicy',
      'id',
      'loopId',
      'providerFamily',
      'status',
      'supportsInterrupt',
      'supportsResume',
      'supportsSteer',
    ])
    assert.equal(JSON.stringify(providerLoopConfig).includes('personal-session'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/read resolves saved provider loop selection without projecting raw keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_PROVIDER: '',
      CHA_CLAUDE_AGENT_LOOP: '',
      CHA_CLAUDE_RUNTIME_TYPE: '',
      CHA_CLAUDE_RUNTIME: '',
      CHA_CLAUDE_BACKEND: '',
      CHA_CLAUDE_MOCK: '',
      CHA_CLAUDE_DISABLE_CODEX_PROXY: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'config/value/write',
        params: { keyPath: 'provider_loop_provider', value: 'codex', mergeStrategy: 'replace' },
      }),
    )
    await reader.nextResponse(1)

    proc.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(2)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult

    assert.deepEqual(providerLoopConfig.selection, {
      providerId: 'codex',
      loopId: 'codex-jsonl-proxy',
      runtimeType: 'codex-proxy',
      source: 'config',
    })
    assert.equal('provider_loop_provider' in config.result.config, false)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'sonnet' },
      }),
    )
    const started = await reader.nextResponse(3)
    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/resume',
        params: { threadId: started.result.thread.id, model: 'opus' },
      }),
    )
    const resumed = await reader.nextResponse(4)
    assert.equal(resumed.result.model, 'opus')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config writes persist across adapter restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  try {
    const first = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        // 默认模型写在 Claude 的 settings.json 里：用用例自己的配置目录，不和同文件的别的用例共用
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        CHA_CLAUDE_MOCK: '1',
        CHA_CLAUDE_DEFAULT_MODEL: 'opus',
        CHA_CLAUDE_DEFAULT_EFFORT: 'high',
        NODE_NO_WARNINGS: '1',
      },
    })
    const firstReader = new JsonLineReader(first)
    first.stdin.write(
      json({
        id: 1,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'haiku', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await firstReader.nextResponse(1)
    first.kill()
    await once(first, 'exit')

    const second = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        // 默认模型写在 Claude 的 settings.json 里：用用例自己的配置目录，不和同文件的别的用例共用
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        CHA_CLAUDE_MOCK: '1',
        CHA_CLAUDE_DEFAULT_MODEL: 'opus',
        CHA_CLAUDE_DEFAULT_EFFORT: 'high',
        NODE_NO_WARNINGS: '1',
      },
    })
    const secondReader = new JsonLineReader(second)
    try {
      second.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
      const config = await secondReader.nextResponse(2)
      assert.equal(config.result.config.model, 'haiku')
      assert.equal(config.result.config.model_reasoning_effort, 'low')

      second.stdin.write(json({ id: 3, method: 'model/list', params: {} }))
      const models = await secondReader.nextResponse(3)
      const haiku = models.result.data.find((model: any) => model.id === 'haiku')
      assert.equal(haiku.isDefault, true)
      assert.equal(haiku.defaultReasoningEffort, 'low')
    } finally {
      second.kill()
      await once(second, 'exit')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('无效持久化模型明确停止启动，不静默换模型或覆盖配置', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const directory = join(home, 'codex-harness-adapter')
  await mkdir(directory, { recursive: true })
  const content = JSON.stringify({
    model: 'runtime-agent-sdk-sidecar',
    model_reasoning_effort: 'high',
  })
  await writeFile(join(directory, 'config.json'), content)
  try {
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        CHA_CLAUDE_MOCK: '1',
        NODE_NO_WARNINGS: '1',
      },
    })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const [code] = await once(proc, 'exit')
    assert.notEqual(code, 0)
    assert.match(stderr, /配置模型不属于当前 Claude 运行时目录/)
    assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), content)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Fable and Opus picker aliases reach the runtime without changing plan mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MODELS: '',
      CHA_CLAUDE_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    let id = 2
    for (const [model, expected] of [
      ['fable', 'fable'],
      ['claude-fable', 'fable'],
      ['opus', 'opus'],
      ['opus-plan', 'opusplan'],
    ]) {
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: {
            threadId,
            model,
            effort: 'high',
            input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
          },
        }),
      )
      await reader.nextResponse(id++)
      let text = ''
      for (;;) {
        const message = await reader.next()
        if (message.method === 'item/agentMessage/delta') text += message.params.delta
        if (message.method === 'turn/completed') break
      }
      assert.equal(text, `model=${expected} effort=high`)
    }
    proc.stdin.write(
      json({
        id,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(id)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'planMode=false')
  } finally {
    proc.kill()
    await once(proc, 'exit')
    await rm(home, { recursive: true, force: true })
  }
})

for (const configuredModels of ['sonnet', '["sonnet"]', '[{"id":"sonnet"}]']) {
  test(`explicit model list remains authoritative: ${configuredModels}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        CHA_CLAUDE_MOCK: '1',
        CHA_CLAUDE_MODELS: configuredModels,
        NODE_NO_WARNINGS: '1',
      },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'model/list', params: {} }))
      const models = await reader.nextResponse(1)
      const ids = models.result.data.map((model: any) => model.id)
      assert.equal(ids.includes('sonnet'), true)
      assert.equal(ids.includes('fable'), false)
      assert.equal(ids.includes('opus-plan'), false)
    } finally {
      proc.kill()
      await once(proc, 'exit')
      await rm(home, { recursive: true, force: true })
    }
  })
}

test('Codex++ model and effort selections map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MODELS: '',
      CHA_CLAUDE_MODEL_ALIASES: '',
      CHA_CLAUDE_EFFORT_ALIASES: JSON.stringify({ xhigh: 'max' }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet-1m',
          effort: 'high',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'sonnet-1m')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'sonnet-1m',
          effort: 'xhigh',
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=sonnet[1m] effort=max')

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.model, 'sonnet-1m')
    assert.equal(resume.result.reasoningEffort, 'xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex app config payload model and effort map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MODELS: '',
      CHA_CLAUDE_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          config: { model: 'opus', model_reasoning_effort: 'high' },
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'opus')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          config: { model: 'haiku', model_reasoning_effort: 'xhigh' },
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=haiku effort=xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex app model ids and outputSchema map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MODELS: '',
      CHA_CLAUDE_MODEL_ALIASES: '',
      CHA_CLAUDE_DEFAULT_MODEL: 'claude-opus-4-6',
      CHA_CLAUDE_SUMMARY_MODEL: 'haiku',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'haiku',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'haiku')

    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'haiku',
          outputSchema,
          input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(JSON.parse(text), {
      model: 'haiku',
      outputFormat: { type: 'json_schema', schema: outputSchema },
    })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex title-generation turn runs through the runtime instead of a hardcoded local title', async () => {
  // We used to short-circuit Codex App's title-gen turn with a regex-derived
  // "处理X" string. That was forcing a hardcoded title regardless of what the
  // model would have produced. Now the turn flows through runRuntimeTurn just
  // like any other structured output turn — the model maps to the summary
  // alias (haiku) and the user message is recorded.
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    const prompt = [
      'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.',
      'Generate a concise UI title (up to 36 characters) for this task.',
      'Fill the structured title field with plain text.',
      '',
      'User prompt:',
      'output schema check',
    ].join('\n')
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'haiku',
          effort: 'medium',
          outputSchema,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        },
      }),
    )
    const turnStart = await reader.nextResponse(2)
    // The turn/start response envelope is empty/notLoaded like the real
    // app-server; the user message is recorded in turn history (verified via
    // thread/read below), not echoed back in the turn envelope.
    assert.deepEqual(turnStart.result.turn.items, [])
    assert.equal(turnStart.result.turn.itemsView, 'notLoaded')

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }

    // The user message IS recorded now (we no longer skip the items list) — it
    // shows up in the persisted turn history.
    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const read = await reader.nextResponse(3)
    const historyItems = (read.result.thread.turns as any[]).flatMap((t) => t.items)
    assert.equal(
      historyItems.some((item: any) => item.type === 'userMessage'),
      true,
    )
    // The text is whatever the runtime produced (the mock echoes the resolved
    // model + outputFormat). Importantly it must NOT be the old hardcoded
    // "处理X" string the local short-circuit would have produced.
    assert.doesNotMatch(text, /^\{"title":"处理/)
    const parsed = JSON.parse(text)
    assert.equal(
      parsed.model,
      'haiku',
      'haiku should map to the summary model (haiku) when an outputSchema is set',
    )
    const logText = await readFile(debugLog, 'utf8')
    assert.doesNotMatch(
      logText,
      /turn\.internalTitle\.shortCircuit/,
      'no local title short-circuit should fire',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stateful HTTP bridge runtimes keep Codex title-generation turns local', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_RUNTIME_TYPE: 'agent-http',
      CHA_CLAUDE_HTTP_BASE_URL: 'http://127.0.0.1:9',
      CHA_CLAUDE_HTTP_MANAGE_BRIDGE: '1',
      CHA_CLAUDE_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'haiku',
          outputSchema,
          input: [{ type: 'text', text: 'User prompt:\nhi', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(JSON.parse(text), { title: 'hi' })
    const logText = await readFile(debugLog, 'utf8')
    assert.match(logText, /"selectedType":"local-structured-summary"/)
    assert.doesNotMatch(logText, /"http\.bridge\.ensure\.start"/)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true })
  }
})

test('default runtime tool policy leaves Claude Code tools unrestricted unless env overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_ALLOWED_TOOLS: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'tool policy check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'allowedTools=default')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix websocket app-server accepts initialize', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(proc, /listening on/)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    await stopProcess(proc)
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix daemon keeps active turns alive across peer reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_IDLE_EXIT_MS: '40',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws1 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader1 = new WebSocketJsonReader(ws1)
    await once(ws1, 'open')
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    const slowPrompt = `active reconnect check ${'x'.repeat(400)}`
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: slowPrompt, text_elements: [] }] },
      }),
    )
    await reader1.nextResponse(2)

    ws1.close()
    await once(ws1, 'close')
    await delay(120)
    assert.equal(proc.exitCode, null)

    const ws2 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader2 = new WebSocketJsonReader(ws2)
    await once(ws2, 'open')
    ws2.send(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'thread/resume', params: { threadId } }),
    )
    await reader2.nextResponse(3)

    let text = ''
    let completed = false
    for (let i = 0; i < 1000; i += 1) {
      const message = await reader2.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)
    assert.match(text, /reconnect check/)

    ws2.close()
    await once(ws2, 'close')
    assert.equal(await waitForExit(proc, 2000), 0)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('unix daemon recovers stale in-progress turns after process restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  let proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws1 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader1 = new WebSocketJsonReader(ws1)
    await once(ws1, 'open')
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: `stale restart check ${'x'.repeat(20_000)}`, text_elements: [] },
          ],
        },
      }),
    )
    const turnStart = await reader1.nextResponse(2)
    const turnId = turnStart.result.turn.id

    proc.kill('SIGKILL')
    await Promise.race([
      once(proc, 'exit'),
      delay(2000).then(() => {
        throw new Error('timed out waiting for killed daemon to exit')
      }),
    ])
    ws1.terminate()

    proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        CHA_CLAUDE_MOCK: '1',
        NODE_NO_WARNINGS: '1',
      },
    })
    await waitForStderr(proc, /listening on/)

    const ws2 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader2 = new WebSocketJsonReader(ws2)
    await once(ws2, 'open')
    ws2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'thread/read',
        params: { threadId, includeTurns: true },
      }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(read.result.thread.status.type, 'idle')
    const recoveredTurn = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    assert.equal(recoveredTurn.status, 'interrupted')
    assert.match(recoveredTurn.error.message, /server restarted before completing turn/)
    ws2.close()
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stdio app-server recovers stale in-progress turns after process restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  let proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    const reader1 = new JsonLineReader(proc)
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            {
              type: 'text',
              text: `stdio stale restart check ${'x'.repeat(20_000)}`,
              text_elements: [],
            },
          ],
        },
      }),
    )
    const turnStart = await reader1.nextResponse(2)
    const turnId = turnStart.result.turn.id

    proc.kill('SIGKILL')
    await Promise.race([
      once(proc, 'exit'),
      delay(2000).then(() => {
        throw new Error('timed out waiting for killed stdio adapter to exit')
      }),
    ])

    proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        CHA_CLAUDE_MOCK: '1',
        NODE_NO_WARNINGS: '1',
      },
    })
    const reader2 = new JsonLineReader(proc)
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(read.result.thread.status.type, 'idle')
    const recoveredTurn = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    assert.equal(recoveredTurn.status, 'interrupted')
    assert.match(recoveredTurn.error.message, /server restarted before completing turn/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery terminalizes persisted in-progress item liveness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const childThreadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'stale item recovery',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: null,
      durationMs: null,
      items: [
        {
          type: 'userMessage',
          id: randomUUID(),
          content: [{ type: 'text', text: 'stale item recovery', text_elements: [] }],
        },
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: childThreadId,
          agentPath: '/root/agent-stale',
        },
        {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'wait',
          status: 'inProgress',
          senderThreadId: threadId,
          receiverThreadIds: [childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { [childThreadId]: { status: 'running', message: null } },
        },
        {
          type: 'commandExecution',
          id: randomUUID(),
          command: 'echo stale',
          cwd: process.cwd(),
          processId: null,
          source: 'shell',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
      diff: '',
      error: null,
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(store.getThread(threadId)?.status.type, 'idle')
    const activity = recovered.items.find((item) => item.type === 'subAgentActivity')
    assert.equal(activity?.type === 'subAgentActivity' ? activity.kind : null, 'interrupted')
    const wait = recovered.items.find(
      (item) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(wait?.type === 'collabAgentToolCall' ? wait.status : null, 'failed')
    assert.equal(
      wait?.type === 'collabAgentToolCall' ? wait.agentsStates[childThreadId]?.status : null,
      'errored',
    )
    const command = recovered.items.find((item) => item.type === 'commandExecution')
    assert.equal(command?.type === 'commandExecution' ? command.status : null, 'failed')
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery repairs stale items on already-terminal turns and is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'terminal item recovery',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'interrupted',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: Math.floor(Date.now() / 1000) - 1,
      durationMs: 1000,
      items: [
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: randomUUID(),
          agentPath: '/root/stale',
        },
        {
          type: 'commandExecution',
          id: randomUUID(),
          command: 'echo stale',
          cwd: process.cwd(),
          processId: null,
          source: 'shell',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
      diff: '',
      error: { message: 'already interrupted' },
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(
      recovered.items.find((item) => item.type === 'subAgentActivity')?.kind,
      'interrupted',
    )
    assert.equal(recovered.items.find((item) => item.type === 'commandExecution')?.status, 'failed')
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery removes legacy activity markers from completed subagent turns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  const childThreadId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'legacy activity history',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'completed',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: Math.floor(Date.now() / 1000) - 1,
      durationMs: 1000,
      items: [
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: childThreadId,
          agentPath: '/root/legacy',
        },
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'completed',
          agentThreadId: childThreadId,
          agentPath: '/root/legacy',
        },
        {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'wait',
          status: 'completed',
          senderThreadId: threadId,
          receiverThreadIds: [childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { [childThreadId]: { status: 'completed', message: null } },
        },
      ],
      diff: '',
      error: null,
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(
      recovered.items.some((item) => item.type === 'subAgentActivity'),
      false,
    )
    assert.equal(store.getThread(threadId)?.status.type, 'idle')
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy forwards websocket handshake bytes to unix daemon', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    await waitForStderr(daemon, /listening on/)
    const stdout = new TextCollector(proxy)
    proxy.stdin?.write(
      [
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )
    await stdout.waitFor(/101 Switching Protocols/)
  } finally {
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy carries websocket JSON-RPC traffic over stdio', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'proxy-test', title: 'Proxy Test', version: '0' },
          capabilities: null,
        },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('remote shim launches daemon and proxy with Codex-compatible commands', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_ADAPTER: adapter,
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const proxy = spawn(shim, ['app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_ADAPTER: adapter,
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'shim-test', title: 'Shim Test', version: '0' },
          capabilities: null,
        },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response?.result?.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('remote utility methods use v2 response shapes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'fs/readFile', params: { path: resolve('README.md') } }))
    const file = await reader.nextResponse(1)
    assert.match(
      Buffer.from(file.result.dataBase64, 'base64').toString('utf8'),
      /codex-harness-adapter/,
    )

    proc.stdin.write(
      json({ id: 2, method: 'fs/getMetadata', params: { path: resolve('README.md') } }),
    )
    const metadata = await reader.nextResponse(2)
    assert.equal(metadata.result.isFile, true)
    assert.equal(metadata.result.isDirectory, false)

    proc.stdin.write(json({ id: 3, method: 'fs/readDirectory', params: { path: process.cwd() } }))
    const directory = await reader.nextResponse(3)
    assert.equal(
      directory.result.entries.some(
        (entry: any) => entry.fileName === 'package.json' && entry.isFile,
      ),
      true,
    )

    proc.stdin.write(
      json({
        id: 4,
        method: 'command/exec',
        params: {
          command: [process.execPath, '-e', 'process.stdout.write("ok")'],
          cwd: process.cwd(),
        },
      }),
    )
    const command = await reader.nextResponse(4)
    assert.deepEqual(command.result, { exitCode: 0, stdout: 'ok', stderr: '' })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('process/spawn supports argv, errors, and debug logs terminal lifecycle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const debugLog = join(home, 'adapter-debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_DEBUG_LOG: debugLog,
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'process/spawn',
        params: {
          processHandle: 'shell-process',
          command: ['/bin/sh', '-c', 'printf shell-ok'],
          cwd: process.cwd(),
          streamStdoutStderr: false,
        },
      }),
    )
    await reader.nextResponse(1)
    let exited: any = null
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'process/exited') {
        exited = message.params
        break
      }
    }
    assert.equal(exited.exitCode, 0)
    assert.equal(exited.stdout, 'shell-ok')

    proc.stdin.write(
      json({
        id: 2,
        method: 'process/spawn',
        params: {
          processHandle: 'missing-process',
          command: ['/definitely/missing/codex-harness-adapter-test'],
          cwd: process.cwd(),
        },
      }),
    )
    const rejected = await reader.nextResponse(2)
    assert.equal(rejected.error.code, -32603)
    assert.match(rejected.error.message, /^failed to spawn process: /)
    assert.match(rejected.error.message, /ENOENT|no such file/i)

    const logText = await debugLogWith(debugLog, /"event":"process.spawn.error"/)
    assert.match(logText, /"event":"process.spawn.start"/)
    assert.match(logText, /"event":"process.spawn.error"/)
    assert.match(logText, /"event":"process.exit"/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('review/start and thread/compact/start emit real turn items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/compact/start', params: { threadId } }))
    await reader.nextResponse(2)
    let sawCompaction = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'contextCompaction')
        sawCompaction = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawCompaction, true)

    proc.stdin.write(
      json({
        id: 3,
        method: 'review/start',
        params: {
          threadId,
          delivery: 'inline',
          target: { type: 'custom', instructions: 'notice event' },
        },
      }),
    )
    const review = await reader.nextResponse(3)
    assert.equal(review.result.reviewThreadId, threadId)
    assert.equal(review.result.turn.status, 'inProgress')
    // Like the real app-server's build_review_turn, the review/start RESPONSE
    // carries the synthesized userMessage (review label) with itemsView
    // notLoaded; enteredReviewMode arrives via the item/started event stream.
    assert.equal(review.result.turn.itemsView, 'notLoaded')
    assert.equal(
      review.result.turn.items.some((item: any) => item.type === 'userMessage'),
      true,
    )
    assert.equal(
      review.result.turn.items.some((item: any) => item.type === 'enteredReviewMode'),
      false,
    )

    let reviewText = ''
    let reviewWarning: any = null
    let sawEnteredReviewMode = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'enteredReviewMode')
        sawEnteredReviewMode = true
      if (message.method === 'item/agentMessage/delta') reviewText += message.params.delta
      if (message.method === 'warning') reviewWarning = message.params
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawEnteredReviewMode, true)
    assert.equal(reviewText, '')
    assert.deepEqual(reviewWarning, { threadId, message: 'mock rate limit notice' })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude thinking maps to a Codex reasoning summary without duplicate raw content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'thinking check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let sawSummary = false
    let sawContent = false
    let completedReasoning: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/reasoning/summaryTextDelta') sawSummary = true
      if (message.method === 'item/reasoning/textDelta') sawContent = true
      if (message.method === 'item/completed' && message.params.item.type === 'reasoning')
        completedReasoning = message.params.item
      if (message.method === 'turn/completed') break
    }
    // 客户端只展示推理摘要：Claude thinking 须以摘要下发，且不重复作为原始内容。
    assert.equal(sawSummary, true)
    assert.equal(sawContent, false)
    assert.deepEqual(completedReasoning.summary, ['mock thinking'])
    assert.deepEqual(completedReasoning.content, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude token usage maps to thread/tokenUsage/updated notifications', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'usage check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let tokenUsage: any = null
    let completedTurn: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/tokenUsage/updated') tokenUsage = message.params
      if (message.method === 'turn/completed') {
        completedTurn = message.params.turn
        break
      }
    }
    assert.ok(tokenUsage, 'expected a thread/tokenUsage/updated notification')
    assert.equal(tokenUsage.threadId, threadId)
    // The Codex v2 Turn schema has no api/cost metadata fields, so turn/completed
    // must not carry the adapter's internal apiDurationMs/numTurns/costUsd; token
    // metrics are surfaced through thread/tokenUsage/updated instead.
    assert.ok(completedTurn, 'turn/completed must arrive')
    assert.ok(!('apiDurationMs' in completedTurn))
    assert.ok(!('numTurns' in completedTurn))
    assert.ok(!('costUsd' in completedTurn))
    // 占用（last）是最后一次请求的：input 30 + cache_creation 5 = 35 input; cache_read 10; output 15.
    assert.deepEqual(tokenUsage.tokenUsage.last, {
      inputTokens: 35,
      cachedInputTokens: 10,
      outputTokens: 15,
      reasoningOutputTokens: 0,
      totalTokens: 60,
    })
    // 累计（total）是整个回合的：input_tokens 100 + cache_creation 5 = 105 input; cache_read 10; output 40.
    assert.deepEqual(tokenUsage.tokenUsage.total, {
      inputTokens: 105,
      cachedInputTokens: 10,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 155,
    })
    assert.equal(tokenUsage.tokenUsage.modelContextWindow, 200_000)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('baseInstructions / developerInstructions / personality flow into the system prompt addendum', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          baseInstructions: 'Always write SQL in lowercase.',
          developerInstructions: 'Avoid SELECT *.',
          personality: 'pragmatic',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'system prompt check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    const addendumLine = text.replace(/^systemPromptAddendum=/, '')
    const addendum = JSON.parse(addendumLine)
    assert.ok(typeof addendum === 'string', 'systemPromptAddendum should be a non-null string')
    assert.match(addendum, /Always write SQL in lowercase\./)
    assert.match(addendum, /Avoid SELECT \*/)
    assert.match(addendum, /Personality: pragmatic/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude hook events are rendered as Codex hookPrompt ThreadItems', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hook check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let hookItem: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'hookPrompt')
        hookItem = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.ok(hookItem, 'hook event should produce a hookPrompt ThreadItem')
    const fragmentTexts = (hookItem.fragments as Array<{ text: string }>).map((f) => f.text)
    assert.ok(
      fragmentTexts.some((t) => /Hook · PreToolUse/.test(t)),
      'fragments should include the hook name',
    )
    assert.ok(
      fragmentTexts.some((t) => /结果: success/.test(t)),
      'fragments should include the status',
    )
    assert.ok(
      fragmentTexts.some((t) => /退出码: 0/.test(t)),
      'fragments should include the native exit code',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/compact/start drives Claude (summary model) instead of the local stringified summary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    // Need a turn or two of content for compactSummary to have snippets.
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello world', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    let firstTurnDone = false
    for (let i = 0; i < 200 && !firstTurnDone; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') firstTurnDone = true
    }

    proc.stdin.write(json({ id: 3, method: 'thread/compact/start', params: { threadId } }))
    await reader.nextResponse(3)

    let agentText = ''
    let sawCompacted = false
    let sawTurnCompleted = false
    for (let i = 0; i < 300 && !(sawCompacted && sawTurnCompleted); i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta')
        agentText += String(message.params.delta ?? '')
      if (message.method === 'thread/compacted') sawCompacted = true
      if (message.method === 'turn/completed') sawTurnCompleted = true
    }
    assert.match(
      agentText,
      /MOCK_COMPACT_SUMMARY/,
      'compact turn should stream the runtime-produced summary, not the local template',
    )
    assert.doesNotMatch(
      agentText,
      /Context compacted for thread/,
      'local fallback should not have fired when the runtime succeeded',
    )
    assert.equal(
      sawCompacted,
      true,
      'thread/compacted notification should still fire after compaction',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('localImage user input becomes a multimodal Claude prompt + an imageView ThreadItem', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  // Tiny 1x1 PNG to avoid pulling a real image binary.
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  )
  const imgPath = join(home, 'pixel.png')
  const fs = await import('node:fs/promises')
  await fs.writeFile(imgPath, png1x1)

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'image input check', text_elements: [] },
            { type: 'localImage', path: imgPath },
          ],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    let imageView: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'imageView')
        imageView = message.params.item
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    // imageView is surfaced live via the item/* event stream (the turn envelope
    // itself stays empty/notLoaded, matching the real app-server).
    assert.ok(imageView, 'turn should emit an imageView item for the user-uploaded image')
    assert.equal(imageView.path, imgPath)
    // Mock echoes the parsed image inputs; assert kind=base64 + media type +
    // a non-trivial payload landed in the runtime context.
    assert.match(
      text,
      /^images=base64:image\/png:\d+/,
      'runtime should receive base64 image input — got: ' + text,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude WebSearch tool maps to native Codex webSearch ThreadItem with action', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'web search check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let webSearchItem: any = null
    let completedWebSearch: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'webSearch')
        webSearchItem = message.params.item
      if (
        message.method === 'item/completed' &&
        webSearchItem &&
        message.params.item.id === webSearchItem.id
      )
        completedWebSearch = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.ok(webSearchItem, 'WebSearch tool_use should emit a native webSearch ThreadItem')
    assert.equal(webSearchItem.query, 'mock query')
    // Protocol-correct action shape: 'search' variant has required query/queries
    // (Option<...> with no serde default) — bare {type:'search'} would crash App.
    assert.deepEqual(webSearchItem.action, { type: 'search', query: 'mock query', queries: null })
    assert.ok(completedWebSearch, 'webSearch item should complete')
    assert.equal(
      completedWebSearch.action.type,
      'openPage',
      'tool_result with a URL should upgrade action to openPage',
    )
    assert.equal(completedWebSearch.action.url, 'https://example.com/article')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('modelProvider/capabilities/read advertises webSearch=true unless CHA_CLAUDE_WEBSEARCH=0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'modelProvider/capabilities/read', params: {} }))
    const cap = await reader.nextResponse(1)
    assert.equal(cap.result.webSearch, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/value/write persists arbitrary settings keys across restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const env = {
    ...isolatedEnv,
    CODEX_HOME: home,
    CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
    CHA_CLAUDE_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  // Round 1: write a custom key + a known typed key.
  const proc1 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  let reader = new JsonLineReader(proc1)
  try {
    proc1.stdin.write(
      json({
        id: 1,
        method: 'config/value/write',
        params: { keyPath: 'approval_policy', value: 'never', mergeStrategy: 'replace' },
      }),
    )
    await reader.nextResponse(1)
    proc1.stdin.write(
      json({
        id: 2,
        method: 'config/value/write',
        params: { keyPath: 'sandbox_mode', value: 'danger-full-access', mergeStrategy: 'replace' },
      }),
    )
    await reader.nextResponse(2)
    proc1.stdin.write(json({ id: 3, method: 'config/read', params: {} }))
    const r = await reader.nextResponse(3)
    assert.equal(
      r.result.config.approval_policy,
      'never',
      'override should appear in config/read on the same process',
    )
    assert.equal(r.result.config.sandbox_mode, 'danger-full-access')
  } finally {
    proc1.kill()
    await once(proc1, 'exit')
  }

  // Round 2: a fresh adapter process re-reads from disk — overrides survive.
  const proc2 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  reader = new JsonLineReader(proc2)
  try {
    proc2.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const r = await reader.nextResponse(1)
    assert.equal(
      r.result.config.approval_policy,
      'never',
      'override must survive restart via persisted overrides bag',
    )
    assert.equal(r.result.config.sandbox_mode, 'danger-full-access')
  } finally {
    proc2.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/inject_items 不支持真实追加的后端必须拒绝且不能伪造助手历史', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/inject_items',
        params: {
          threadId,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'pinned context' }],
            },
          ],
        },
      }),
    )
    const response = await reader.nextResponse(2)
    assert.equal(response.error.code, -32004)
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    assert.deepEqual((await reader.nextResponse(3)).result.thread.turns, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/start planMode=true flows into Claude SDK permission_mode plan', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          planMode: true,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    // 计划模式里说的话照上游 codex 是回答（agentMessage）：只有 <proposed_plan> 块进计划条目。
    // turn/plan/updated 只给 update_plan/TodoWrite 那种清单用，计划模式的文字不发它。
    let answerText = ''
    let planText = ''
    let sawPlanUpdated = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') answerText += message.params.delta
      if (message.method === 'item/plan/delta') planText += message.params.delta
      if (message.method === 'turn/plan/updated') sawPlanUpdated = true
      if (message.method === 'turn/completed') break
    }
    assert.match(answerText, /planMode=true/, 'the runtime context reaches the answer')
    assert.equal(planText, '', 'plain plan-mode text is not a plan item')
    assert.equal(sawPlanUpdated, false, 'plan-mode text must not emit turn/plan/updated')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('TodoWrite maps to a Codex v2 turn/plan/updated notification, not a timeline item', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'update the todo list', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let planUpdate: any = null
    let sawTodoItem = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/plan/updated') planUpdate = message.params
      if (
        (message.method === 'item/started' || message.method === 'item/completed') &&
        /todo/i.test(message.params.item?.tool ?? '')
      )
        sawTodoItem = true
      if (message.method === 'turn/completed') break
    }
    assert.ok(planUpdate, 'expected a turn/plan/updated notification')
    // Codex v2 TurnPlanUpdatedNotification = { threadId, turnId, explanation, plan }.
    assert.equal(planUpdate.threadId, threadId)
    assert.equal(planUpdate.explanation, null)
    assert.deepEqual(planUpdate.plan, [
      { step: 'Investigate', status: 'completed' },
      { step: 'Implement', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ])
    // The checklist tool itself is not surfaced as a separate timeline item.
    assert.equal(sawTodoItem, false, 'TodoWrite must not produce a timeline tool item')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex App approvalPolicy=never + sandbox=danger-full-access auto-accepts tool calls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    // Envelope reflects the App's chosen policy/sandbox instead of the previous hardcoded `on-request` + workspaceWrite.
    assert.equal(start.result.approvalPolicy, 'never')
    assert.equal((start.result.sandbox as any).type, 'dangerFullAccess')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let sawApprovalRequest = false
    let sawCommandOutput = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/commandExecution/requestApproval') sawApprovalRequest = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawCommandOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(
      sawApprovalRequest,
      false,
      'expected no requestApproval round-trip when approvalPolicy=never',
    )
    assert.equal(sawCommandOutput, true, 'tool should still execute and stream output')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Task subagent emits the canonical activity lifecycle and leaves wait as the terminal display state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_SUBAGENT_COMPLETED: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: { name: 'codex-test-modern', title: 'Codex test', version: 'modern' },
          capabilities: { subAgentActivityCompleted: true },
        },
      }),
    )
    await reader.nextResponse(0)
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    type Lifecycle = { started?: any; completed?: any }
    const collabByTool: Record<string, Lifecycle> = {}
    let agentMessageText = ''
    let childThreadStarted: any = null
    let childTurnStarted: any = null
    let childPromptStarted: any = null
    let childPromptCompleted: any = null
    let childAgentStarted: any = null
    let childAgentCompleted: any = null
    let childAgentMessageText = ''
    let childTurnCompleted: any = null
    let liveChildRead: any = null
    let leakedInnerItems = 0
    const subagentActivityStarted = new Map<string, any>()
    const subagentActivities: any[] = []
    const parentCompletedOrder: string[] = []
    const spawnCompletions: any[] = []
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.id === 50) liveChildRead = message.result.thread
      if (
        message.method === 'thread/started' &&
        message.params.thread?.threadSource === 'subagent'
      ) {
        childThreadStarted = message.params.thread
      }
      if (message.method === 'turn/started' && message.params.threadId !== threadId) {
        childTurnStarted = message.params.turn
        proc.stdin.write(
          json({
            id: 50,
            method: 'thread/read',
            // The bundled Codex cc panel uses includeTurns:false while it
            // opens a child. The adapter must still hydrate this subagent.
            params: { threadId: message.params.threadId, includeTurns: false },
          }),
        )
      }
      if (message.method === 'item/started') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptStarted = item
        } else if (message.params.threadId !== threadId && item.type === 'agentMessage') {
          childAgentStarted = item
        } else if (item.type === 'subAgentActivity') {
          subagentActivityStarted.set(item.id, item)
        } else if (item.type === 'collabAgentToolCall') {
          const bucket = (collabByTool[item.tool] ??= {})
          bucket.started = item
        } else if (
          item.type === 'commandExecution' ||
          (item.type === 'mcpToolCall' && item.tool !== 'Task')
        ) {
          leakedInnerItems += 1
        }
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptCompleted = item
        } else if (message.params.threadId !== threadId && item.type === 'agentMessage') {
          childAgentCompleted = item
        } else if (item.type === 'subAgentActivity') {
          subagentActivities.push(item)
          parentCompletedOrder.push(`activity:${item.kind}`)
        } else if (item.type === 'collabAgentToolCall') {
          const bucket = (collabByTool[item.tool] ??= {})
          bucket.completed = item
          parentCompletedOrder.push(`collab:${item.tool}`)
          if (item.tool === 'spawnAgent') spawnCompletions.push(item)
        }
      }
      if (message.method === 'item/agentMessage/delta') {
        if (message.params.threadId === threadId) {
          agentMessageText += String(message.params.delta ?? '')
        } else {
          childAgentMessageText += String(message.params.delta ?? '')
        }
      }
      if (message.method === 'turn/completed') {
        if (message.params.threadId === threadId) break
        childTurnCompleted = message.params.turn
      }
    }

    // Native V2 uses activity items for liveness and leaves wait/completed as
    // the final parent item. Closing an already-finished child makes older App
    // reducers discard that completed state and fall back to "started".
    for (const tool of ['spawnAgent', 'wait']) {
      const lc = collabByTool[tool]
      assert.ok(lc?.started, `expected item/started for ${tool}`)
      assert.ok(lc?.completed, `expected item/completed for ${tool}`)
      assert.equal(lc.started.id, lc.completed.id, `${tool} begin/end must share a single item id`)
      assert.equal(
        lc.completed.status,
        'completed',
        `${tool} should complete with status=completed`,
      )
    }
    const spawnEnd = collabByTool.spawnAgent!.completed!
    assert.equal(spawnEnd.senderThreadId, threadId)
    assert.equal(
      spawnEnd.receiverThreadIds.length,
      1,
      'spawnAgent end should reference exactly one child thread',
    )
    const childThreadId = spawnEnd.receiverThreadIds[0]!
    assert.deepEqual(
      subagentActivities.map((item) => item.kind),
      ['started', 'completed'],
      'subagent activity must transition from started to completed',
    )
    assert.equal(subagentActivities[0].agentThreadId, childThreadId)
    assert.equal(subagentActivities[1].agentThreadId, childThreadId)
    assert.equal(subagentActivities[0].agentPath, subagentActivities[1].agentPath)
    assert.match(subagentActivities[0].agentPath, /^\/root\/[A-Za-z0-9_-]+$/)
    assert.equal(subagentActivityStarted.size, 2)
    for (const completedActivity of subagentActivities) {
      assert.deepEqual(
        subagentActivityStarted.get(completedActivity.id),
        completedActivity,
        `${completedActivity.kind} activity must emit item/started and item/completed with the same id`,
      )
    }
    assert.ok(
      parentCompletedOrder.indexOf('activity:completed') <
        parentCompletedOrder.indexOf('collab:wait'),
      'completed activity must arrive before wait/completed so the bundled App keeps the final done state',
    )
    assert.equal(
      collabByTool.closeAgent,
      undefined,
      'a naturally completed child must not receive a synthetic closeAgent lifecycle',
    )
    assert.ok(childThreadStarted, 'subagent must emit child thread/started for live navigation')
    assert.equal(childThreadStarted.id, childThreadId)
    assert.equal(
      childThreadStarted.parentThreadId,
      threadId,
      'subagent thread metadata must identify its parent thread',
    )
    assert.equal(childThreadStarted.recencyAt, childThreadStarted.updatedAt)
    assert.deepEqual(childThreadStarted.source, {
      subAgent: {
        thread_spawn: {
          parent_thread_id: threadId,
          depth: 1,
          agent_path: null,
          agent_nickname: childThreadStarted.agentNickname,
          agent_role: 'general-purpose',
        },
      },
    })
    assert.ok(childTurnStarted, 'subagent must emit child turn/started before its result')
    assert.equal(childTurnStarted.status, 'inProgress')
    assert.equal(childTurnStarted.itemsView, 'notLoaded')
    assert.deepEqual(childTurnStarted.items, [])
    assert.ok(childPromptStarted, 'subagent prompt must emit child userMessage item/started')
    assert.ok(childPromptCompleted, 'subagent prompt must emit child userMessage item/completed')
    assert.equal(childPromptStarted.id, childPromptCompleted.id)
    assert.equal(childPromptCompleted.content[0].text, 'investigate')
    assert.ok(liveChildRead, 'opening a running subagent must return its child turn')
    assert.equal(liveChildRead.turns.length, 1)
    assert.equal(liveChildRead.turns[0].status, 'inProgress')
    const liveItems = liveChildRead.turns[0].items
    assert.equal(
      liveItems.find((item: any) => item.type === 'userMessage').content[0].text,
      'investigate',
    )
    assert.equal(
      liveItems.some((item: any) => item.type === 'agentMessage'),
      false,
    )
    assert.ok(childAgentStarted, 'subagent result must emit child agentMessage item/started')
    assert.equal(childAgentStarted.text, '')
    assert.match(childAgentMessageText, /subagent final summary/)
    assert.ok(childAgentCompleted, 'subagent result must emit child agentMessage item/completed')
    assert.equal(childAgentCompleted.id, childAgentStarted.id)
    assert.match(childAgentCompleted.text, /subagent final summary/)
    assert.ok(
      childTurnCompleted,
      'subagent must emit child turn/completed before parent completion',
    )
    assert.equal(childTurnCompleted.id, childTurnStarted.id)
    assert.equal(childTurnCompleted.status, 'completed')
    assert.equal(
      childTurnCompleted.itemsView,
      'summary',
      'completed subagent turns must carry their final response in the terminal envelope',
    )
    assert.equal(childTurnCompleted.items.length, 1)
    assert.equal(childTurnCompleted.items[0].type, 'agentMessage')
    assert.equal(childTurnCompleted.items[0].id, childAgentCompleted.id)
    assert.match(childTurnCompleted.items[0].text, /subagent final summary/)
    // After spawnAgent ends the subagent is now running; wait/completed is the
    // terminal display snapshot after the activity completion event.
    // 子代理结束时派出的那一条以同一个标识再完成一次，带上最后的状态，排在等待那一条之前
    assert.deepEqual(
      spawnCompletions.map((item) => [item.id, item.agentsStates[childThreadId]?.status]),
      [
        [collabByTool.spawnAgent!.started!.id, 'running'],
        [collabByTool.spawnAgent!.started!.id, 'completed'],
      ],
    )
    assert.ok(
      parentCompletedOrder.lastIndexOf('collab:spawnAgent') <
        parentCompletedOrder.indexOf('collab:wait'),
      'wait/completed stays the final parent item',
    )
    assert.equal(spawnEnd.agentsStates[childThreadId]!.status, 'completed')
    assert.equal(collabByTool.wait!.started!.receiverThreadIds[0], childThreadId)
    assert.equal(collabByTool.wait!.completed!.agentsStates[childThreadId]!.status, 'completed')
    // collabAgentToolCall.model carries the SDK model the subagent runs on,
    // NOT Claude's subagent_type — the App's "Agent · model" badge depends
    // on this. The mock runs without a subagent_type so the parent's model
    // 默认沿用原生配置；子代理继承父会话的默认模型选择。
    assert.equal(
      spawnEnd.model,
      'default',
      'collabAgentToolCall.model should be the parent thread model when no Task input.model is set',
    )

    // Codex App reads agentRole/agentNickname off the child thread to render
    // its native subagent identity. The mock has no subagent_type so we fall
    // back to "general-purpose"; agentNickname mirrors Claude's `agent-{hex}`
    // shape so the App can show a stable handle for this subagent instance.
    proc.stdin.write(json({ id: 5, method: 'thread/read', params: { threadId: childThreadId } }))
    const childRead = await reader.nextResponse(5)
    const childThread = childRead.result.thread
    assert.equal(childThread.threadSource, 'subagent')
    // 子线程跟随父线程，不再一律标成临时线程。
    assert.equal(childThread.ephemeral, false)
    assert.equal(childThread.agentRole, 'general-purpose')
    // The Task tool_result carried an `agentId: deadbeefcafef00d` trailer
    // (mock mirrors the real claude-agent-sdk format). The server strips it
    // from the visible text; 昵称保持子线程出现时的那个，不换成代理 ID。
    assert.match(childThread.agentNickname, /^agent-[0-9a-f]{12}$/)
    assert.equal(childThread.agentNickname, childThreadStarted.agentNickname)
    assert.equal(
      childThread.forkedFromId,
      threadId,
      'subagent thread should be forked from the parent user thread',
    )

    // Trailer is stripped from the child thread's visible agentMessage.
    proc.stdin.write(
      json({ id: 6, method: 'thread/turns/list', params: { threadId: childThreadId } }),
    )
    const childTurns = await reader.nextResponse(6)
    assert.equal(childTurns.result.data.length, 1, 'subagent should use one live child turn')
    const childTurnItems = (childTurns.result.data[0] as any).items
    const childPrompt = childTurnItems.find((i: any) => i.type === 'userMessage')
    assert.equal(childPrompt.content[0].text, 'investigate')
    const childAgent = childTurnItems.find((i: any) => i.type === 'agentMessage')
    assert.ok(childAgent, 'child thread should have an agentMessage with the subagent result')
    assert.doesNotMatch(
      childAgent.text,
      /agentId:/,
      '`agentId:` trailer should be stripped from the visible body',
    )
    assert.doesNotMatch(
      childAgent.text,
      /<usage>/,
      '`<usage>` block should be stripped from the visible body',
    )
    assert.match(
      childAgent.text,
      /subagent final summary/,
      'the real subagent body must still be there',
    )

    // A same-process late-opened parent must replay a terminal activity, not
    // the stale started marker that drives the App spinner.
    proc.stdin.write(
      json({ id: 8, method: 'thread/turns/list', params: { threadId, itemsView: 'full' } }),
    )
    const liveParentTurns = await reader.nextResponse(8)
    const liveActivityKinds = (liveParentTurns.result.data as any[])
      .flatMap((turn: any) => turn.items ?? [])
      .filter((item: any) => item.type === 'subAgentActivity')
      .map((item: any) => item.kind)
    assert.deepEqual(
      liveActivityKinds,
      [],
      'same-process parent history must not retain capability-specific activity markers',
    )

    assert.equal(leakedInnerItems, 0, 'inner Bash tool calls should not appear at the parent level')
    assert.doesNotMatch(
      agentMessageText,
      /subagent thinking aloud/,
      'subagent text should not bleed into the main agent message',
    )
    assert.match(
      agentMessageText,
      /main agent summary/,
      'main agent text after subagent should still appear',
    )

    // 子线程的来源是 subAgent，不进普通列表；includeEphemeral 只管临时线程，与它无关。
    proc.stdin.write(json({ id: 3, method: 'thread/list', params: {} }))
    const list = await reader.nextResponse(3)
    const ids = (list.result.data as any[]).map((t) => t.id)
    assert.ok(
      !ids.includes(childThreadId),
      'subagent child thread should be hidden from thread/list',
    )
    assert.ok(ids.includes(threadId), 'parent user thread should remain visible')

    proc.stdin.write(json({ id: 4, method: 'thread/list', params: { includeEphemeral: true } }))
    const listAll = await reader.nextResponse(4)
    const allIds = (listAll.result.data as any[]).map((t) => t.id)
    assert.ok(
      !allIds.includes(childThreadId),
      'includeEphemeral=true must not turn the subagent child into a regular thread',
    )

    // Codex App discovers subagents after reconnect through the standard
    // parent/source filters, without setting includeEphemeral explicitly.
    proc.stdin.write(
      json({
        id: 7,
        method: 'thread/list',
        params: {
          parentThreadId: threadId,
          sourceKinds: ['subAgentThreadSpawn'],
          sortDirection: 'desc',
          sortKey: 'created_at',
          useStateDbOnly: true,
          limit: 200,
        },
      }),
    )
    const discovered = await reader.nextResponse(7)
    assert.deepEqual(
      discovered.result.data.map((thread: any) => thread.id),
      [childThreadId],
      'standard subagent discovery must return the child for its parent',
    )

    // Generic and thread-spawn source kinds are representable by this
    // adapter. The omitted sortKey also exercises the protocol default
    // (created_at). Other variants are intentionally unsupported because the
    // persisted schema has no discriminator for them.
    for (const [index, sourceKind] of ['subAgent', 'subAgentThreadSpawn'].entries()) {
      const id = 80 + index
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: {
            parentThreadId: threadId,
            sourceKinds: [sourceKind],
            limit: 200,
          },
        }),
      )
      const variant = await reader.nextResponse(id)
      assert.deepEqual(
        variant.result.data.map((thread: any) => thread.id),
        [childThreadId],
        `${sourceKind} should discover the subagent child`,
      )
    }
    for (const [index, sourceKind] of [
      'subAgentReview',
      'subAgentCompact',
      'subAgentOther',
    ].entries()) {
      const id = 90 + index
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: { parentThreadId: threadId, sourceKinds: [sourceKind], limit: 200 },
        }),
      )
      const variant = await reader.nextResponse(id)
      assert.deepEqual(
        variant.result.data.map((thread: any) => thread.id),
        [],
        `${sourceKind} should not mislabel a thread-spawn child`,
      )
    }

    // Restart the adapter and replay the parent turn from SQLite. The bundled
    // App reduces items in persisted order, so wait/completed must still be
    // the last subagent state after a cold restart. Activity markers are
    // live-only extensions; the durable history stays capability-neutral.
    const exited = once(proc, 'exit')
    proc.kill()
    await exited
    const restarted = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...isolatedEnv,
        CODEX_HOME: home,
        CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
        CHA_CLAUDE_MOCK: '1',
        NODE_NO_WARNINGS: '1',
      },
    })
    const restartedReader = new JsonLineReader(restarted)
    try {
      restarted.stdin.write(
        json({
          id: 1,
          method: 'thread/turns/list',
          params: { threadId, itemsView: 'full' },
        }),
      )
      const persistedTurns = await restartedReader.nextResponse(1)
      const persistedItems = persistedTurns.result.data[0].items.filter(
        (item: any) => item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall',
      )
      assert.deepEqual(
        persistedItems.map((item: any) =>
          item.type === 'subAgentActivity'
            ? `activity:${item.kind}`
            : `collab:${item.tool}:${item.status}`,
        ),
        ['collab:spawnAgent:completed', 'collab:wait:completed'],
        'cold-open history must not retain a started activity marker after wait/completed',
      )

      restarted.stdin.write(
        json({
          id: 2,
          method: 'thread/list',
          params: {
            parentThreadId: threadId,
            sourceKinds: ['subAgentThreadSpawn'],
            sortDirection: 'desc',
            sortKey: 'created_at',
            useStateDbOnly: true,
            limit: 200,
          },
        }),
      )
      const rediscovered = await restartedReader.nextResponse(2)
      assert.deepEqual(
        rediscovered.result.data.map((thread: any) => thread.id),
        [childThreadId],
        'a cold App connection must rediscover the persisted subagent child',
      )
      assert.equal(rediscovered.result.data[0].status.type, 'idle')
      assert.equal(rediscovered.result.data[0].isPinned, false)

      restarted.stdin.write(
        json({
          id: 3,
          method: 'thread/read',
          // Cold-open follows the same metadata-only request as Codex cc.
          params: { threadId: childThreadId, includeTurns: false },
        }),
      )
      const coldChild = (await restartedReader.nextResponse(3)).result.thread
      assert.equal(coldChild.turns.length, 1)
      assert.equal(coldChild.turns[0].status, 'completed')
      assert.equal(coldChild.turns[0].itemsView, 'full')
      assert.equal(
        coldChild.turns[0].items.find((item: any) => item.type === 'userMessage').content[0].text,
        'investigate',
      )
      assert.match(
        coldChild.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
        /subagent final summary/,
      )

      restarted.stdin.write(
        json({
          id: 4,
          method: 'thread/read',
          params: { threadId, includeTurns: false },
        }),
      )
      const metadataOnlyParent = (await restartedReader.nextResponse(4)).result.thread
      assert.equal(
        metadataOnlyParent.turns.length,
        0,
        'ordinary thread/read includeTurns:false must remain metadata-only',
      )
    } finally {
      restarted.kill()
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex cc 26.818 settles subagents without the unsupported completed activity kind', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'Codex Desktop',
            title: 'Codex Desktop',
            version: '26.818.61809',
          },
          capabilities: { experimentalApi: true },
        },
      }),
    )
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    const activityKinds: string[] = []
    let childThreadId = ''
    let childPromptStarted: any = null
    let childPromptCompleted: any = null
    let waitCompleted: any = null
    let sawCloseAgent = false
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptStarted = item
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawCloseAgent = true
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptCompleted = item
        }
        if (item.type === 'subAgentActivity') activityKinds.push(item.kind)
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
          childThreadId = String(item.receiverThreadIds[0] ?? '')
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'wait') waitCompleted = item
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawCloseAgent = true
      }
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    assert.deepEqual(
      activityKinds,
      [],
      'Codex cc 26.818 must use spawnAgent/wait lifecycle instead of an unsupported started marker',
    )
    assert.ok(childPromptStarted)
    assert.ok(childPromptCompleted)
    assert.equal(childPromptStarted.id, childPromptCompleted.id)
    assert.equal(childPromptCompleted.content[0].text, 'investigate')
    assert.ok(childThreadId)
    assert.ok(waitCompleted)
    assert.equal(waitCompleted.status, 'completed')
    assert.equal(waitCompleted.agentsStates[childThreadId].status, 'completed')
    assert.equal(
      sawCloseAgent,
      false,
      'successful legacy subagents must keep wait/completed as the visible terminal state',
    )

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/read',
        params: { threadId: childThreadId, includeTurns: false },
      }),
    )
    const legacyChild = (await reader.nextResponse(3)).result.thread
    assert.equal(legacyChild.turns.length, 1)
    assert.equal(legacyChild.turns[0].status, 'completed')
    assert.equal(legacyChild.turns[0].itemsView, 'full')
    assert.equal(
      legacyChild.turns[0].items.find((item: any) => item.type === 'userMessage').content[0].text,
      'investigate',
    )
    assert.match(
      legacyChild.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
      /subagent final summary/,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('subagent without a terminal result emits interrupted activity and failed wait', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'orphan subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let childThreadId = ''
    let waitStatus = ''
    let sawClose = false
    const activityKinds: string[] = []
    let childTurnCompleted: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')
          childThreadId = String(item.receiverThreadIds[0] ?? '')
        if (item.type === 'collabAgentToolCall' && item.tool === 'wait') waitStatus = item.status
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawClose = true
        if (item.type === 'subAgentActivity') activityKinds.push(item.kind)
      }
      if (message.method === 'turn/completed' && message.params.threadId !== threadId)
        childTurnCompleted = message.params.turn
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    assert.ok(childThreadId)
    assert.equal(waitStatus, 'failed')
    assert.equal(
      sawClose,
      true,
      'legacy Codex cc needs closeAgent to clear an orphaned child spinner',
    )
    assert.deepEqual(activityKinds, ['interrupted'])
    assert.ok(childTurnCompleted)
    assert.equal(childTurnCompleted.status, 'failed')
    assert.equal(childTurnCompleted.itemsView, 'notLoaded')
    assert.deepEqual(childTurnCompleted.items, [])
    proc.stdin.write(
      json({ id: 3, method: 'thread/turns/list', params: { threadId: childThreadId } }),
    )
    const childTurns = await reader.nextResponse(3)
    assert.equal(childTurns.result.data[0].status, 'failed')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('bare /workflows lists prior workflow runs without invoking the model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: '/workflows subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(3)
    let listText = ''
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') listText += message.params.delta
      if (message.method === 'turn/completed') break
    }

    assert.match(listText, /Workflow runs in this task:/)
    assert.match(listText, /1 agent\(s\)/)
    assert.match(listText, /subagent check/)
    assert.doesNotMatch(listText, /Claude Code adapter mock response/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/start picks up effort from config.model_reasoning_effort when top-level effort is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    // Codex App's settings sheet writes the persistent effort under
    // params.config.model_reasoning_effort (snake_case, just like the CLI's
    // config.toml). Make sure we accept it from there even when the top-level
    // `effort` field is absent — without this fix the user's "high" pick
    // gets silently dropped and Claude runs at the env default.
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), config: { model_reasoning_effort: 'high' } },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    // Drive a turn with effort=null on the wire (mimicking what Codex App
    // actually sends — top-level effort is null, the real value came in via
    // thread/start.config). Mock echoes the effort the runtime received.
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'effort echo', text_elements: [] }],
          effort: null,
          model: null,
        },
      }),
    )
    await reader.nextResponse(2)
    let echoed = ''
    for (let i = 0; i < 500; i += 1) {
      const message: any = await reader.next()
      if (message.method === 'item/agentMessage/delta') echoed += String(message.params.delta ?? '')
      if (message.method === 'turn/completed') break
    }
    assert.equal(
      echoed,
      'effort=high',
      'config.model_reasoning_effort should flow through to the runtime',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/start coerces invalid threadSource / source values so Codex App never sees a non-enum', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    // Empty string and bogus enum values must round-trip as null, not as the
    // literal "" / "totally-bogus" — otherwise App ts-rs deserializer panics
    // on reopen and shows "Oops, an error has occurred".
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), threadSource: '' } }),
    )
    const empty = await reader.nextResponse(1)
    assert.equal(
      empty.result.thread.threadSource,
      null,
      'empty threadSource must serialize as null',
    )
    assert.equal(empty.result.thread.source, 'appServer', 'source must use camelCase wire form')

    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), threadSource: 'totally-bogus' },
      }),
    )
    const bogus = await reader.nextResponse(2)
    assert.equal(
      bogus.result.thread.threadSource,
      null,
      'unknown threadSource enum must serialize as null',
    )

    // Valid enum values still pass through unchanged.
    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/start',
        params: { cwd: process.cwd(), threadSource: 'subagent' },
      }),
    )
    const valid = await reader.nextResponse(3)
    assert.equal(valid.result.thread.threadSource, 'subagent')

    // Empty string for agentRole / agentNickname collapses to null on the wire.
    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/start',
        params: { cwd: process.cwd(), agentRole: '', agentNickname: '' },
      }),
    )
    const empties = await reader.nextResponse(4)
    assert.equal(empties.result.thread.agentRole, null)
    assert.equal(empties.result.thread.agentNickname, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('旧数据库在打开写连接前被拒绝，内容保持不变', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-format-'))
  const path = join(home, 'state.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec("CREATE TABLE old_data(value TEXT); INSERT INTO old_data VALUES ('preserve')")
    old.close()
    const before = await readFile(path)
    assert.throws(() => new SessionStore(path), /旧适配器数据库不受支持/)
    assert.deepEqual(await readFile(path), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('thread/start with ephemeral=true is hidden from thread/list and surfaces threadSource', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          ephemeral: true,
          threadSource: 'memory_consolidation',
          model: 'haiku',
        },
      }),
    )
    const ephemeralStart = await reader.nextResponse(1)
    const ephemeralId = ephemeralStart.result.thread.id
    assert.equal(
      ephemeralStart.result.thread.ephemeral,
      true,
      'envelope should reflect ephemeral=true',
    )
    assert.equal(ephemeralStart.result.thread.threadSource, 'memory_consolidation')

    proc.stdin.write(
      json({ id: 2, method: 'thread/start', params: { cwd: process.cwd(), threadSource: 'user' } }),
    )
    const userStart = await reader.nextResponse(2)
    const userId = userStart.result.thread.id
    // 列表照上游不列还没说过话的会话：暂停的目标给它预览
    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/goal/set',
        params: { threadId: userId, objective: '列出来', status: 'paused' },
      }),
    )
    assert.equal((await reader.nextResponse(3)).error, undefined)

    proc.stdin.write(json({ id: 4, method: 'thread/list', params: {} }))
    const list = await reader.nextResponse(4)
    const ids = (list.result.data as any[]).map((t) => t.id)
    assert.ok(ids.includes(userId), 'normal user thread should appear')
    assert.ok(!ids.includes(ephemeralId), 'ephemeral title/summary thread should be filtered out')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('debug.jsonl rotates once it crosses CHA_CLAUDE_DEBUG_LOG_MAX_BYTES', async () => {
  const util = await import(resolve('packages/claude/dist/claude/src/util.mjs'))
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-rotate-'))
  const logPath = join(home, 'debug.jsonl')
  const prevPath = process.env.CHA_CLAUDE_DEBUG_LOG
  const prevMax = process.env.CHA_CLAUDE_DEBUG_LOG_MAX_BYTES
  const prevKeep = process.env.CHA_CLAUDE_DEBUG_LOG_KEEP
  process.env.CHA_CLAUDE_DEBUG_LOG = logPath
  process.env.CHA_CLAUDE_DEBUG_LOG_MAX_BYTES = '512'
  process.env.CHA_CLAUDE_DEBUG_LOG_KEEP = '2'
  try {
    // Each line is ~150 bytes; write enough to cross 512 bytes twice.
    for (let i = 0; i < 30; i += 1) util.debugLog('test.rotate', { i, payload: 'x'.repeat(120) })
    // 调试日志攒到这一轮事件循环末尾才写，这里当场写出去
    util.flushDebugLog()
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(home)
    assert.ok(entries.includes('debug.jsonl'), 'active log should exist')
    assert.ok(entries.includes('debug.jsonl.1'), 'rotation should have produced a .1 slot')
    // KEEP=2 means at most .1 + .2; .3 must never appear.
    assert.ok(
      !entries.includes('debug.jsonl.3'),
      'rotation should respect CHA_CLAUDE_DEBUG_LOG_KEEP',
    )
    const activeSize = (await fs.stat(logPath)).size
    assert.ok(activeSize < 512 * 4, 'active log should have been freshly started after rotation')
  } finally {
    if (prevPath == null) delete process.env.CHA_CLAUDE_DEBUG_LOG
    else process.env.CHA_CLAUDE_DEBUG_LOG = prevPath
    if (prevMax == null) delete process.env.CHA_CLAUDE_DEBUG_LOG_MAX_BYTES
    else process.env.CHA_CLAUDE_DEBUG_LOG_MAX_BYTES = prevMax
    if (prevKeep == null) delete process.env.CHA_CLAUDE_DEBUG_LOG_KEEP
    else process.env.CHA_CLAUDE_DEBUG_LOG_KEEP = prevKeep
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('defaultSocketPath stays within the platform sun_path limit', async () => {
  const util = await import(resolve('packages/claude/dist/claude/src/util.mjs'))
  const prev = process.env.CODEX_HOME
  process.env.CODEX_HOME = '/' + 'very-long-codex-home-segment'.repeat(8)
  try {
    const socketPath = util.defaultSocketPath()
    assert.ok(
      socketPath.length <= util.socketPathLimit(),
      `socket path ${socketPath.length} exceeds limit ${util.socketPathLimit()}`,
    )
  } finally {
    if (prev == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  }
})

test('approval requests round-trip through Codex server requests', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          permissions: ':workspace',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawWaitingOnApproval = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (
        message.method === 'thread/status/changed' &&
        message.params.status.activeFlags?.includes('waitingOnApproval')
      ) {
        sawWaitingOnApproval = true
      }
      if (message.method === 'item/commandExecution/requestApproval') {
        approvalRequest = message
        break
      }
    }
    assert.equal(approvalRequest?.params.command, 'echo mock approval')
    assert.equal(sawWaitingOnApproval, true)
    proc.stdin.write(json({ id: approvalRequest.id, result: { decision: 'accept' } }))

    let sawResolved = false
    let sawOutput = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'serverRequest/resolved') sawResolved = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawResolved, true)
    assert.equal(sawOutput, true)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('generic Claude tools complete as Codex mcpToolCall items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please use generic tool', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let completedTool: any = null
    let sawIdle = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/status/changed' && message.params.status.type === 'idle')
        sawIdle = true
      if (message.method === 'item/completed' && message.params.item.type === 'mcpToolCall')
        completedTool = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.equal(completedTool?.tool, 'Read README.md')
    assert.equal(completedTool?.status, 'completed')
    // Result must be wrapped in Codex v2 McpToolCallResult shape — {content[], structuredContent, _meta}.
    // The mock runtime returns {text:'mock read result'} as the raw content, which we wrap as:
    //   content: [{type:'text', text:'<json>'}], structuredContent: <object>, _meta: null.
    assert.deepEqual(completedTool?.result, {
      content: [{ type: 'text', text: JSON.stringify({ text: 'mock read result' }) }],
      structuredContent: { text: 'mock read result' },
      _meta: null,
    })
    assert.equal(sawIdle, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/steer appends user input to an active Claude turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'slow turn for steering', text_elements: [] }],
        },
      }),
    )
    const started = await reader.nextResponse(2)
    const turnId = started.result.turn.id

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/steer',
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text: 'steered input', text_elements: [] }],
        },
      }),
    )
    const steer = await reader.nextResponse(3)
    assert.equal(steer.result.turnId, turnId)

    let completed = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)

    proc.stdin.write(
      json({ id: 4, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(4)
    assert.equal(
      items.result.data.some(
        (item: any) => item.type === 'userMessage' && item.content?.[0]?.text === 'steered input',
      ),
      true,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// 和上游一样：谁开的回合、谁插的话，用户消息都作为条目发给会话的全部订阅者，带着发起方给的 clientId。
// 别的连接（设备进程开的唤醒、提醒回合，手机上发的话）开的回合，正看着这个会话的客户端因此能实时看到那条用户消息
test('user messages of turn/start and turn/steer reach every subscriber live, with clientId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const open = async () => {
    const ws = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const frames: any[] = []
    ws.on('message', (data) => frames.push(JSON.parse(String(data))))
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    return { ws, reader, frames }
  }
  const userEvents = (frames: any[], clientId: string) =>
    frames.filter(
      (frame) =>
        (frame.method === 'item/started' || frame.method === 'item/completed') &&
        frame.params.item?.type === 'userMessage' &&
        frame.params.item.clientId === clientId,
    )
  try {
    await waitForStderr(proc, /listening on/)
    const a = await open()
    const b = await open()
    a.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: {} }))
    const threadId = (await a.reader.nextResponse(1)).result.thread.id
    b.ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/resume', params: { threadId } }),
    )
    await b.reader.nextResponse(1)

    a.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          clientUserMessageId: 'start-1',
          input: [{ type: 'text', text: 'slow turn for steering', text_elements: [] }],
        },
      }),
    )
    const turnId = (await a.reader.nextResponse(2)).result.turn.id
    a.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'turn/steer',
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: 'steer-1',
          input: [{ type: 'text', text: 'steered input', text_elements: [] }],
        },
      }),
    )
    assert.equal((await a.reader.nextResponse(3)).result.turnId, turnId)
    for (let i = 0; i < 500; i += 1) {
      const message = await b.reader.next()
      if (message.method === 'turn/completed') break
    }

    for (const [who, frames] of [
      ['A', a.frames],
      ['B', b.frames],
    ] as const) {
      for (const [clientId, text] of [
        ['start-1', 'slow turn for steering'],
        ['steer-1', 'steered input'],
      ] as const) {
        const events = userEvents(frames, clientId)
        assert.deepEqual(
          events.map((frame) => frame.method),
          ['item/started', 'item/completed'],
          `${who} 收到 ${clientId} 的开始、完成各一次`,
        )
        assert.equal(events[0].params.item.id, events[1].params.item.id)
        assert.equal(events[0].params.turnId, turnId)
        assert.equal(events[0].params.item.content[0].text, text)
      }
    }
    a.ws.close()
    b.ws.close()
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('AskUserQuestion is bridged to Codex item/tool/requestUserInput', async () => {
  // Bug repro: Claude's AskUserQuestion tool calls weren't surfaced in the
  // App UI — they fell through as generic mcpToolCall items with no choice
  // card. We bridge them to Codex's native request_user_input reverse RPC
  // so the App pops its structured picker, then route the user's answer
  // back to the model.
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'ask user question check', text_elements: [] }],
        },
      }),
    )
    const started = await reader.nextResponse(2)
    const turnId = started.result.turn.id

    // Wait for the server's reverse-RPC asking us to answer. Real Codex
    // protocol: request id is numeric/server-side, params carry the
    // structured questions.
    let askRequest: any | null = null
    while (askRequest == null) {
      const message = await reader.next()
      if (message.method === 'item/tool/requestUserInput') {
        askRequest = message
      }
    }
    assert.equal(askRequest.params.threadId, threadId)
    assert.equal(askRequest.params.turnId, turnId)
    assert.equal(Array.isArray(askRequest.params.questions), true)
    assert.equal(askRequest.params.questions[0].header, 'Auth')
    assert.equal(askRequest.params.questions[0].question, 'Which auth method do you want?')
    // “选项之外自己说”只用题目上的 isOther 表示：选项是模型出的那两个，引擎不往里补假选项。
    assert.equal(askRequest.params.questions[0].isOther, true)
    assert.deepEqual(
      askRequest.params.questions[0].options.map((o: any) => o.label),
      ['OAuth', 'API Key'],
    )

    // Answer as the App would.
    proc.stdin.write(
      json({
        jsonrpc: '2.0',
        id: askRequest.id,
        result: { answers: { q0: { answers: ['OAuth'] } } },
      }),
    )

    let completed = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)

    proc.stdin.write(
      json({ id: 4, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(4)
    const itemsList = items.result.data as Array<any>
    const dynamic = itemsList.find((item) => item.type === 'dynamicToolCall')
    assert.ok(dynamic, 'expected a dynamicToolCall item in the turn')
    assert.equal(dynamic.tool, 'AskUserQuestion')
    assert.equal(dynamic.status, 'completed')
    assert.equal(dynamic.success, true)
    assert.equal(Array.isArray(dynamic.contentItems), true)
    assert.match(dynamic.contentItems[0].text, /OAuth/)
    // No stray mcpToolCall for AskUserQuestion (otherwise the App would
    // draw a duplicate generic card alongside the choice picker).
    assert.equal(
      itemsList.some((item) => item.type === 'mcpToolCall' && item.tool === 'AskUserQuestion'),
      false,
    )
    // The chosen answer also reached the mock through onUserInputRequest's
    // return value (and got echoed back as the final agent message text).
    const agent = itemsList.find((item) => item.type === 'agentMessage')
    assert.ok(
      agent && /picked=OAuth/.test(agent.text),
      'expected the agent message to echo the picked answer',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('compatibility-only UI methods return schema-shaped responses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/increment_elicitation', params: { threadId } }))
    assert.deepEqual((await reader.nextResponse(2)).result, { count: 1, paused: true })

    proc.stdin.write(json({ id: 3, method: 'thread/decrement_elicitation', params: { threadId } }))
    assert.deepEqual((await reader.nextResponse(3)).result, { count: 0, paused: false })

    proc.stdin.write(
      json({
        id: 4,
        method: 'experimentalFeature/enablement/set',
        params: { enablement: { demo: true } },
      }),
    )
    const unsupportedFeature = await reader.nextResponse(4)
    assert.equal(unsupportedFeature.error.code, -32004)
    assert.equal(unsupportedFeature.result, undefined)

    proc.stdin.write(json({ id: 5, method: 'mock/experimentalMethod', params: { value: 'ok' } }))
    assert.deepEqual((await reader.nextResponse(5)).result, { echoed: 'ok' })

    proc.stdin.write(json({ id: 6, method: 'permissionProfile/list', params: {} }))
    assert.deepEqual((await reader.nextResponse(6)).result, {
      data: [
        { id: ':read-only', description: null, allowed: true },
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      nextCursor: null,
    })

    proc.stdin.write(json({ id: 7, method: 'windowsSandbox/readiness', params: {} }))
    assert.deepEqual((await reader.nextResponse(7)).result, { status: 'notConfigured' })

    proc.stdin.write(json({ id: 7, method: 'plugin/install', params: { pluginName: 'demo' } }))
    assert.equal((await reader.nextResponse(7)).error.code, -32004)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('file change approval emits patch and git diff updates', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await writeFile(join(repo, 'tracked.md'), 'committed\n')
  execFileSync('git', ['add', 'README.md', 'tracked.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )
  // 回合开始前已存在的未提交改动与未跟踪文件不属于本回合，不能进入回合 diff。
  await writeFile(join(repo, 'tracked.md'), 'PRE_EXISTING_CHANGE\n')
  await writeFile(join(repo, 'untracked.txt'), 'PRE_EXISTING_UNTRACKED\n')

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: repo,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          permissions: ':workspace',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please edit file', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawPatch = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/fileChange/patchUpdated') sawPatch = true
      if (message.method === 'item/fileChange/requestApproval') {
        approvalRequest = message
        break
      }
    }
    assert.equal(sawPatch, true)
    assert.equal(approvalRequest?.params.threadId, threadId)
    proc.stdin.write(json({ id: approvalRequest.id, result: { decision: 'accept' } }))

    let diff = ''
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/diff/updated') diff = message.params.diff
      if (message.method === 'turn/completed') break
    }
    assert.match(diff, /README.md/)
    assert.match(diff, /changed by mock runtime/)
    assert.doesNotMatch(diff, /tracked\.md|untracked\.txt|PRE_EXISTING/)
    assert.equal(
      execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }),
      '',
    )
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('gitDiffToRemote 与 Codex 一致：以最近的远端基准比较，含未推送提交与未跟踪文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  const origin = join(home, 'origin.git')
  const repo = join(home, 'repo')
  const lonely = join(home, 'lonely')
  execFileSync('mkdir', ['-p', origin, repo, lonely])
  git(origin, 'init', '--bare', '-b', 'main')
  git(repo, 'init', '-b', 'main')
  await writeFile(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  git(repo, 'checkout', '-b', 'dev')
  await writeFile(join(repo, 'dev.txt'), 'dev\n')
  git(repo, 'add', 'dev.txt')
  git(repo, 'commit', '-m', 'dev')
  git(repo, 'push', '-u', 'origin', 'dev')
  const devSha = git(repo, 'rev-parse', 'HEAD')
  const mainSha = git(repo, 'rev-parse', 'origin/main')
  git(repo, 'checkout', '-b', 'feature')
  await writeFile(join(repo, 'new-file.txt'), 'new content\n')
  git(lonely, 'init', '-b', 'main')
  await writeFile(join(lonely, 'a.txt'), 'a\n')
  git(lonely, 'add', 'a.txt')
  git(lonely, 'commit', '-m', 'a')

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    // feature 刚从非默认的 origin/dev 分出：origin/dev 包含 HEAD 且距离为 0，基准是 dev。
    proc.stdin.write(json({ id: 1, method: 'gitDiffToRemote', params: { cwd: repo } }))
    const forked = await reader.nextResponse(1)
    assert.equal(forked.result.sha, devSha)
    assert.doesNotMatch(forked.result.diff, /dev\.txt/)
    assert.match(forked.result.diff, /new file mode[\s\S]*\+new content/)

    // 有了未推送提交后，没有远端分支包含 HEAD，按原生回退到默认分支 origin/main。
    await writeFile(join(repo, 'unpushed.txt'), 'unpushed change\n')
    git(repo, 'add', 'unpushed.txt')
    git(repo, 'commit', '-m', 'unpushed')
    proc.stdin.write(json({ id: 3, method: 'gitDiffToRemote', params: { cwd: repo } }))
    const ahead = await reader.nextResponse(3)
    assert.equal(ahead.result.sha, mainSha)
    assert.match(ahead.result.diff, /\+dev/)
    assert.match(ahead.result.diff, /\+unpushed change/)
    assert.match(ahead.result.diff, /\+new content/)

    proc.stdin.write(json({ id: 2, method: 'gitDiffToRemote', params: { cwd: lonely } }))
    const failure = await reader.nextResponse(2)
    assert.equal(failure.error.code, -32600)
    assert.equal(
      failure.error.message,
      `failed to compute git diff to remote for cwd: ${JSON.stringify(lonely)}`,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread resume, fork, and interrupt lifecycle methods are stable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'session check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.thread.id, threadId)
    assert.equal(resume.result.thread.turns.length, 1)

    proc.stdin.write(
      json({ id: 4, method: 'thread/fork', params: { threadId, persistExtendedHistory: false } }),
    )
    const fork = await reader.nextResponse(4)
    assert.equal(fork.result.thread.forkedFromId, threadId)
    assert.notEqual(fork.result.thread.sessionId, resume.result.thread.sessionId)

    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/interrupt',
        params: {
          threadId,
          turnId: resume.result.thread.turns[0].id,
        },
      }),
    )
    const interrupt = await reader.nextResponse(5)
    assert.deepEqual(interrupt.result, {})
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn interrupt completes requested in-progress turn after reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { randomUUID } from 'node:crypto'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const threadId = randomUUID()
      const turnId = randomUUID()
      const now = Math.floor(Date.now() / 1000)
      store.upsertThread({
        id: threadId,
        sessionId: randomUUID(),
        forkedFromId: null,
        preview: 'interrupt me',
        name: null,
        archived: false,
        cwd: process.cwd(),
        model: 'opus',
        reasoningEffort: 'medium',
        modelProvider: 'claude-code',
        claudeSessionId: null,
        source: 'user',
        createdAt: now,
        updatedAt: now,
        status: { type: 'active', activeFlags: [] },
        approvalPolicy: null,
        sandboxMode: null,
        ephemeral: false,
        threadSource: 'user',
        agentRole: null,
        agentNickname: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        runtimeBackend: 'claude',
        codexSessionId: null,
      })
      store.upsertTurn({
        id: turnId,
        threadId,
        status: 'inProgress',
        startedAt: now,
        completedAt: null,
        durationMs: null,
        items: [],
        diff: '',
        error: null,
      })
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt(id) {
          interrupted.push(id)
        },
        async stop() {},
      })
      const messages = []
      const peer = {
        id: 'peer',
        send(message) {
          messages.push(message)
        },
        close() {},
      }
      await server.handle(peer, { id: 1, method: 'turn/interrupt', params: { threadId, turnId } })
      assert.deepEqual(interrupted, [threadId])
      assert.equal(store.getTurn(turnId)?.status, 'interrupted')
      // 用户打断不是出错：库里和 turn/completed 里都不带错误（和上游一样）
      assert.equal(store.getTurn(turnId)?.error, null)
      assert.equal(store.getThread(threadId)?.status.type, 'idle')
      const completed = messages.find((message) => 'method' in message && message.method === 'turn/completed')
      assert.equal(completed?.params.turn.id, turnId)
      assert.equal(completed?.params.turn.status, 'interrupted')
      assert.equal(completed?.params.turn.error, null)
      const status = messages.find((message) => 'method' in message && message.method === 'thread/status/changed')
      assert.deepEqual(status?.params.status, { type: 'idle' })
      const response = messages.find((message) => 'id' in message && message.id === 1)
      assert.deepEqual(response?.result, {})
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('runtime settlement cannot overwrite an interrupted turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const controls = new Map()
      const controlsByThread = new Map()
      const outcomes = new Map()
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'active-' + context.turnId,
            toolName: 'Task',
            input: { description: 'active subagent', prompt: 'wait for interruption' },
          })
          return new Promise((resolve, reject) => {
            const control = { resolve, reject }
            controls.set(context.turnId, control)
            controlsByThread.set(context.threadId, control)
          })
        },
        async steer() {},
        async interrupt(threadId) {
          const control = controlsByThread.get(threadId)
          if (outcomes.get(threadId) === 'resolve') control.resolve()
          else control.reject(new Error('runtime rejected during interrupt'))
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
        async stop() {},
      })
      const messages = []
      const peer = {
        id: 'peer',
        send(message) {
          messages.push({ ...message, deliveredTo: 'peer' })
        },
        close() {},
      }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for runtime control')
      }

      let requestId = 0
      for (const outcome of ['resolve', 'reject']) {
        await server.handle(peer, {
          id: ++requestId,
          method: 'thread/start',
          params: { cwd: process.cwd(), persistExtendedHistory: false },
        })
        const threadId = response(requestId).result.thread.id
        await server.handle(peer, {
          id: ++requestId,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: 'interrupt workflow', text_elements: [] }],
          },
        })
        const turnId = response(requestId).result.turn.id
        await waitFor(() => controls.has(turnId))
        outcomes.set(threadId, outcome)
        const interruptPeer = {
          id: 'peer-reconnected',
          send(message) {
            messages.push({ ...message, deliveredTo: 'peer-reconnected' })
          },
          close() {},
        }
        server.closePeer(peer)
        await server.handle(interruptPeer, {
          id: ++requestId,
          method: 'thread/resume',
          params: { threadId },
        })
        await server.handle(interruptPeer, {
          id: ++requestId,
          method: 'turn/interrupt',
          params: { threadId, turnId },
        })
        await new Promise((resolve) => setTimeout(resolve, 25))

        assert.equal(store.getTurn(turnId)?.status, 'interrupted')
        const completions = messages.filter(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        )
        assert.equal(completions.length, 1)
        assert.equal(completions[0].params.turn.status, 'interrupted')
        const interruptedActivityIndex = messages.findIndex(
          (message) =>
            'method' in message &&
            message.method === 'item/completed' &&
            message.params.turnId === turnId &&
            message.params.item.type === 'subAgentActivity' &&
            message.params.item.kind === 'interrupted',
        )
        const terminalIndex = messages.findIndex(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        )
        assert.ok(interruptedActivityIndex >= 0)
        assert.ok(interruptedActivityIndex < terminalIndex)
        assert.equal(messages[interruptedActivityIndex].deliveredTo, 'peer-reconnected')
        assert.equal(messages[terminalIndex].deliveredTo, 'peer-reconnected')
        assert.equal(
          messages
            .filter(
              (message) =>
                'method' in message &&
                message.method === 'item/completed' &&
                message.params.turnId === turnId &&
                message.params.item.type === 'collabAgentToolCall' &&
                message.params.item.tool === 'wait',
            )
            .every((message) => message.deliveredTo === 'peer-reconnected'),
          true,
        )
        assert.equal(
          messages.some(
            (message) =>
              'method' in message &&
              message.method === 'error' &&
              message.params.turnId === turnId,
          ),
          false,
        )
      }
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('subagent watchdog terminalizes a runtime that never returns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      process.env.CHA_CLAUDE_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'stuck-' + context.turnId,
            toolName: 'Task',
            input: { description: 'stuck subagent', prompt: 'never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for watchdog')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hang', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )

      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /no subagent activity for 1 second/)
      assert.equal(interrupted.length, 1)
      const child = store
        .listThreads({ includeEphemeral: true })
        .find((candidate) => candidate.threadSource === 'subagent')
      assert.ok(child)
      assert.equal(store.listTurns(child.id)[0].status, 'failed')
      assert.equal(store.listTurns(threadId)[0].items.at(-1).status, 'failed')
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('workflow watchdog terminalizes a launch that never publishes a result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      process.env.CHA_CLAUDE_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'workflow-' + context.turnId,
            toolName: 'Workflow',
            input: { command: '/workflows never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for workflow watchdog')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows hang', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )
      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /no subagent activity for 1 second/)
      assert.equal(interrupted.length, 1)
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'item/started' &&
            message.params.item.type === 'collabAgentToolCall',
        ),
        false,
        'a Workflow launch without projected agents must not fabricate a child card',
      )
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('workflow watchdog disarms when the original Workflow tool result arrives', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      process.env.CHA_CLAUDE_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          const toolUseId = 'workflow-launch-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Workflow',
            input: { command: '/workflows slow result' },
          })
          await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'launch accepted' })
          await new Promise((resolve) => setTimeout(resolve, 250))
          await handlers.onEvent({ type: 'completed', success: true, result: 'workflow done' })
        },
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for original Workflow result')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows slow', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )
      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('server shutdown terminalizes active child turns before closing the store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const database = join(home, 'state.sqlite')
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(${JSON.stringify(database)})
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'shutdown-child-' + context.turnId,
            toolName: 'Task',
            input: { description: 'child survives shutdown', prompt: 'investigate shutdown' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for child creation')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const parentThreadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId: parentThreadId, input: [{ type: 'text', text: 'hang', text_elements: [] }] },
      })
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'item/completed' &&
            message.params.item?.tool === 'spawnAgent',
        ),
      )
      await server.stop()

      const reopened = new SessionStore(${JSON.stringify(database)})
      try {
        const child = reopened
          .listThreads({ includeEphemeral: true })
          .find((candidate) => candidate.threadSource === 'subagent')
        assert.ok(child)
        assert.equal(reopened.listTurns(child.id)[0].status, 'failed')
        assert.equal(reopened.listTurns(parentThreadId)[0].status, 'interrupted')
        assert.equal(reopened.listTurns(parentThreadId)[0].items.at(-1).status, 'failed')
        assert.equal(
          reopened.listThreads({ includeEphemeral: true }).flatMap((thread) => reopened.listTurns(thread.id)).some((turn) => turn.status === 'inProgress'),
          false,
        )
      } finally {
        reopened.close()
      }
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('interrupt during final git diff cannot overwrite an interrupted turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const repo = join(home, 'repo')
  const bin = join(home, 'bin')
  const diffStarted = join(home, 'git-diff-started')
  const diffRelease = join(home, 'git-diff-release')
  await mkdir(repo, { recursive: true })
  await mkdir(bin, { recursive: true })
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const fakeGit = join(bin, 'git')
  await writeFile(
    fakeGit,
    [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then',
      "  printf 'true\\n'",
      '  exit 0',
      'fi',
      'if [ "$1" = "diff" ]; then',
      '  : > "$CHA_CLAUDE_TEST_GIT_DIFF_STARTED"',
      '  while [ ! -f "$CHA_CLAUDE_TEST_GIT_DIFF_RELEASE" ]; do sleep 0.01; done',
      "  printf 'diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new\\n'",
      '  exit 0',
      'fi',
      'exec "$CHA_CLAUDE_REAL_GIT" "$@"',
      '',
    ].join('\n'),
  )
  await chmod(fakeGit, 0o755)

  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { existsSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './packages/claude/dist/claude/src/server.mjs'
      import { SessionStore } from './packages/claude/dist/claude/src/store.mjs'

      process.env.CHA_CLAUDE_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for final git diff')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: ${JSON.stringify(repo)}, persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'interrupt during final diff', text_elements: [] }],
        },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() => existsSync(process.env.CHA_CLAUDE_TEST_GIT_DIFF_STARTED))

      await server.handle(peer, {
        id: 3,
        method: 'turn/interrupt',
        params: { threadId, turnId },
      })
      writeFileSync(process.env.CHA_CLAUDE_TEST_GIT_DIFF_RELEASE, 'continue')
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(store.getTurn(turnId)?.status, 'interrupted')
      const completions = messages.filter(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completions.length, 1)
      assert.equal(completions[0].params.turn.status, 'interrupted')
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/diff/updated' &&
            message.params.turnId === turnId,
        ),
        false,
      )
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'error' &&
            message.params.turnId === turnId,
        ),
        false,
      )
      await server.stop()
    `,
      ],
      {
        cwd: resolve('.'),
        stdio: 'pipe',
        env: {
          ...isolatedEnv,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CHA_CLAUDE_REAL_GIT: realGit,
          CHA_CLAUDE_TEST_GIT_DIFF_STARTED: diffStarted,
          CHA_CLAUDE_TEST_GIT_DIFF_RELEASE: diffRelease,
        },
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('MCP 子进程退出必须返回明确错误', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MCP_SERVERS: JSON.stringify({
        demo: { type: 'stdio', command: 'node', args: ['mcp.js'] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    assert.equal(response.error.code, -32001)
    assert.ok(!('result' in response))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('direct MCP stdio resource and tool calls work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const fixture = resolve('packages/claude/test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MCP_SERVERS: JSON.stringify({
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 10,
        method: 'thread/start',
        params: { cwd: home, sandbox: 'danger-full-access', approvalPolicy: 'never' },
      }),
    )
    const started = await reader.nextResponse(10)
    const threadId = started.result.thread.id
    proc.stdin.write(
      json({
        id: 1,
        method: 'mcpServer/tool/call',
        params: { threadId, server: 'fixture', tool: 'echo', arguments: { value: 'ok' } },
      }),
    )
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'tool:echo:ok')
    assert.equal(tool.result.structuredContent.ok, true)

    proc.stdin.write(
      json({
        id: 2,
        method: 'mcpServer/resource/read',
        params: { threadId, server: 'fixture', uri: 'fixture://resource' },
      }),
    )
    const resource = await reader.nextResponse(2)
    assert.equal(resource.result.contents[0].uri, 'fixture://resource')
    assert.equal(resource.result.contents[0].text, 'resource-ok')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcpServerStatus/list enumerates tools and resources from the server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const fixture = resolve('packages/claude/test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MCP_SERVERS: JSON.stringify({
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    const entry = response.result.data[0]
    assert.equal(entry.name, 'fixture')
    assert.ok(entry.tools.echo, 'expected the echo tool enumerated into the map')
    assert.equal(entry.tools.echo.name, 'echo')
    assert.ok(entry.tools.echo.inputSchema, 'tool must carry its inputSchema')
    assert.equal(entry.resources[0].uri, 'fixture://resource')
    assert.ok(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(entry.authStatus))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('fuzzyFileSearch 会话与 Codex 一致：先响应后通知、每次搜索都完成、停止不发完成', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const root = join(home, 'root')
  await mkdir(join(root, 'finddir'), { recursive: true })
  await writeFile(join(root, 'findme-fixture.txt'), 'x')
  await writeFile(join(root, 'finddir', 'inner.txt'), 'x')
  await writeFile(join(root, '.hidden-find.txt'), 'x')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  let id = 0
  const request = (method: string, params: unknown) => {
    id += 1
    proc.stdin.write(json({ id, method, params }))
    return id
  }
  // 读到指定请求的响应为止，返回期间收到的所有消息（含响应）。
  const until = async (requestId: number) => {
    const messages: any[] = []
    for (;;) {
      const message = await reader.next()
      messages.push(message)
      if (message.id === requestId && message.method == null) return messages
    }
  }
  const search = async (query: string) => {
    const updateId = request('fuzzyFileSearch/sessionUpdate', { sessionId: 's1', query })
    const response = await reader.next()
    assert.equal(response.id, updateId, '更新须先返回响应，再发送通知')
    const updated = await reader.next()
    assert.equal(updated.method, 'fuzzyFileSearch/sessionUpdated')
    const completed = await reader.next()
    assert.equal(completed.method, 'fuzzyFileSearch/sessionCompleted')
    assert.equal(completed.params.sessionId, 's1')
    return updated.params
  }
  try {
    const startId = request('fuzzyFileSearch/sessionStart', { sessionId: 's1', roots: [root] })
    assert.deepEqual((await reader.next()).result, {}, `sessionStart ${startId}`)
    const initial = await reader.next()
    assert.equal(initial.method, 'fuzzyFileSearch/sessionUpdated')
    assert.deepEqual(initial.params, { sessionId: 's1', query: '', files: [] })
    assert.equal((await reader.next()).method, 'fuzzyFileSearch/sessionCompleted')

    const found = await search('findme')
    assert.equal(found.query, 'findme')
    assert.ok(
      found.files.some(
        (file: any) => file.path === 'findme-fixture.txt' && file.match_type === 'file',
      ),
    )
    const directory = await search('finddir')
    assert.ok(
      directory.files.some(
        (file: any) => file.path === 'finddir' && file.match_type === 'directory',
      ),
    )
    const hidden = await search('hidden-find')
    assert.ok(hidden.files.some((file: any) => file.path === '.hidden-find.txt'))
    assert.deepEqual((await search('')).files, [])

    // 连续更新：最新更新的响应之后只允许报告最新查询；更早的查询可能已在其前完成。
    request('fuzzyFileSearch/sessionUpdate', { sessionId: 's1', query: 'zzz-stale' })
    const latestId = request('fuzzyFileSearch/sessionUpdate', { sessionId: 's1', query: 'findme' })
    await until(latestId)
    const reported = [await reader.next(), await reader.next()]
    assert.equal(reported[0].method, 'fuzzyFileSearch/sessionUpdated')
    assert.equal(reported[0].params.query, 'findme')
    assert.equal(reported[1].method, 'fuzzyFileSearch/sessionCompleted')

    const stopId = request('fuzzyFileSearch/sessionStop', { sessionId: 's1' })
    assert.deepEqual((await reader.next()).result, {}, `sessionStop ${stopId}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterStopId = request('fuzzyFileSearch/sessionUpdate', {
      sessionId: 's1',
      query: 'findme',
    })
    const afterStop = await until(afterStopId)
    assert.equal(afterStop.length, 1, '停止后不得再有任何会话通知')
    assert.equal(afterStop[0].error.code, -32600)
    assert.equal(afterStop[0].error.message, 'fuzzy file search session not found: s1')

    const emptyIdRequest = request('fuzzyFileSearch/sessionStart', { sessionId: '', roots: [root] })
    assert.equal((await reader.next()).error.code, -32600, `empty sessionId ${emptyIdRequest}`)
    const emptyRootsRequest = request('fuzzyFileSearch/sessionStart', {
      sessionId: 's2',
      roots: [],
    })
    assert.equal((await reader.next()).error.code, -32603, `empty roots ${emptyRootsRequest}`)
    const oneShot = request('fuzzyFileSearch', { query: '', roots: [root] })
    assert.deepEqual((await reader.next()).result, { files: [] }, `one-shot ${oneShot}`)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('fuzzyFileSearch 遍历部分出错（不可读目录、软链接循环）时保留已列出的结果', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const root = join(home, 'root')
  const locked = join(root, 'locked')
  await mkdir(locked, { recursive: true })
  await writeFile(join(root, 'findme-partial.txt'), 'x')
  execFileSync('ln', ['-s', '.', join(root, 'loop')])
  // rg 与 find 遇到不可读目录都会以非零状态结束，但其余条目已经列出。
  execFileSync('chmod', ['000', locked])
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({ id: 1, method: 'fuzzyFileSearch', params: { query: 'findme', roots: [root] } }),
    )
    const response = await reader.nextResponse(1)
    assert.ok(
      response.result.files.some((file: any) => file.path === 'findme-partial.txt'),
      JSON.stringify(response.result),
    )
  } finally {
    proc.kill()
    execFileSync('chmod', ['755', locked])
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/backgroundTerminals 列出、分页、结束与清理本轮后台 shell', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  let id = 0
  const call = async (method: string, params: unknown) => {
    id += 1
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const missing = await call('thread/backgroundTerminals/list', { threadId: 'no-such-thread' })
    assert.equal(missing.error.code, -32600)
    assert.equal(missing.error.message, 'thread not found: no-such-thread')

    const started = await call('thread/start', { cwd: home })
    const threadId = started.result.thread.id
    const idle = await call('thread/backgroundTerminals/list', { threadId })
    assert.deepEqual(idle.result, { data: [], nextCursor: null })

    id += 1
    const turnRequest = id
    proc.stdin.write(
      json({
        id: turnRequest,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'mock background shells', text_elements: [] }],
        },
      }),
    )
    const commandItems: Record<string, string> = {}
    while (Object.keys(commandItems).length < 2) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'commandExecution')
        commandItems[message.params.item.processId] = message.params.item.id
    }

    const listed = await call('thread/backgroundTerminals/list', { threadId })
    assert.deepEqual(
      listed.result.data.map((terminal: any) => [terminal.processId, terminal.command]),
      [
        ['claude:tool-bg-1', 'sleep 101'],
        ['claude:tool-bg-2', 'sleep 102'],
      ],
    )
    assert.equal(listed.result.data[0].itemId, commandItems['claude:tool-bg-1'])
    assert.equal(listed.result.data[0].cwd, home)
    assert.equal(listed.result.data[0].osPid, null)

    const page = await call('thread/backgroundTerminals/list', { threadId, limit: 1 })
    assert.equal(page.result.data.length, 1)
    assert.equal(page.result.nextCursor, 'claude:tool-bg-1')
    const next = await call('thread/backgroundTerminals/list', {
      threadId,
      cursor: page.result.nextCursor,
      limit: 1,
    })
    assert.deepEqual(
      next.result.data.map((terminal: any) => terminal.processId),
      ['claude:tool-bg-2'],
    )
    assert.equal(next.result.nextCursor, null)

    const first = await call('thread/backgroundTerminals/terminate', {
      threadId,
      processId: 'claude:tool-bg-1',
    })
    assert.deepEqual(first.result, { terminated: true })
    const again = await call('thread/backgroundTerminals/terminate', {
      threadId,
      processId: 'claude:tool-bg-1',
    })
    assert.deepEqual(again.result, { terminated: false })

    const cleaned = await call('thread/backgroundTerminals/clean', { threadId })
    assert.deepEqual(cleaned.result, {})
    for (;;) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }
    const after = await call('thread/backgroundTerminals/list', { threadId })
    assert.deepEqual(after.result, { data: [], nextCursor: null })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('skills/list and hooks/list surface Claude Code skills and settings hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const workspace = join(home, 'ws')
  await mkdir(join(home, '.claude', 'skills', 'user-skill'), { recursive: true })
  await writeFile(
    join(home, '.claude', 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: A user skill for tests\n---\nbody\n',
  )
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    }),
  )
  await mkdir(join(workspace, '.claude', 'skills', 'demo-skill'), { recursive: true })
  await writeFile(
    join(workspace, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for tests\n---\nbody\n',
  )
  await writeFile(
    join(workspace, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'ignored' }] }],
      },
    }),
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      HOME: home,
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'skills/list', params: { cwds: [workspace] } }))
    const skills = await reader.nextResponse(1)
    const entry = skills.result.data.find((item: Record<string, unknown>) => item.cwd === workspace)
    assert.ok(entry, 'expected a skills entry for the workspace cwd')
    const skillList = Array.isArray(entry.skills) ? entry.skills : []
    const demo = skillList.find((skill: Record<string, unknown>) => skill.name === 'demo-skill')
    assert.ok(demo, 'expected the demo skill enumerated from .claude/skills')
    assert.equal(demo.description, 'A demo skill for tests')
    assert.equal(demo.scope, 'repo')
    assert.equal(demo.enabled, true)
    const userSkill = skillList.find(
      (skill: Record<string, unknown>) => skill.name === 'user-skill',
    )
    assert.ok(userSkill, 'expected the user skill enumerated from HOME/.claude/skills')
    assert.equal(userSkill.description, 'A user skill for tests')
    assert.equal(userSkill.scope, 'user')
    assert.equal(userSkill.enabled, true)

    proc.stdin.write(json({ id: 2, method: 'hooks/list', params: { cwds: [workspace] } }))
    const hooks = await reader.nextResponse(2)
    const hooksEntry = hooks.result.data.find(
      (item: Record<string, unknown>) => item.cwd === workspace,
    )
    assert.ok(hooksEntry, 'expected a hooks entry for the workspace cwd')
    const hookList = Array.isArray(hooksEntry.hooks) ? hooksEntry.hooks : []
    const pre = hookList.find(
      (hook: Record<string, unknown>) => hook.source === 'project' && hook.command === 'echo hi',
    )
    assert.ok(pre, 'expected the project PreToolUse hook mapped to preToolUse')
    assert.equal(pre.eventName, 'preToolUse')
    assert.equal(pre.matcher, 'Bash')
    assert.equal(pre.handlerType, 'command')
    assert.ok(typeof pre.currentHash === 'string' && pre.currentHash.length > 0)
    const userHook = hookList.find(
      (hook: Record<string, unknown>) => hook.source === 'user' && hook.command === 'echo user',
    )
    assert.ok(userHook, 'expected the user settings hook mapped from HOME/.claude/settings.json')
    assert.equal(userHook.eventName, 'postToolUse')
    assert.equal(userHook.matcher, 'Edit')
    assert.equal(userHook.handlerType, 'command')
    assert.ok(!hookList.some((hook: Record<string, unknown>) => hook.eventName === 'notification'))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('direct MCP HTTP tool calls work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const effect = join(home, 'http-effect.txt')
  const mcp = new LocalMcp(() => writeFile(effect, 'executed'))
  const url = await mcp.start()
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: home,
          permissions: ':danger-full-access',
          config: {
            mcp_servers: {
              fixture: {
                url,
                http_headers: {
                  Authorization: 'Bearer test-not-a-secret',
                  'X-Runtime': 'claude-fixture',
                },
              },
            },
          },
        },
      }),
    )
    const start = await reader.nextResponse(1)
    proc.stdin.write(
      json({
        id: 2,
        method: 'mcpServer/tool/call',
        params: {
          threadId: start.result.thread.id,
          server: 'fixture',
          tool: 'touch_fixture',
          arguments: {},
        },
      }),
    )
    const tool = await reader.nextResponse(2)
    assert.equal(tool.error, undefined, JSON.stringify(tool.error))
    assert.equal(tool.result.content[0].text, 'MCP_FILE_WRITTEN')
    assert.equal(await readFile(effect, 'utf8'), 'executed')
    assert.equal(mcp.calls, 1)
    assert.deepEqual(mcp.errors, [])
  } finally {
    proc.kill()
    await mcp.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('optional auto worktree binds new threads to isolated git worktrees', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const repo = join(home, 'repo')
  const worktrees = join(home, 'worktrees')
  await writeFile(join(home, 'placeholder'), '')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_AUTO_WORKTREE: '1',
      CHA_CLAUDE_WORKTREE_ROOT: worktrees,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: repo, experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.match(response.result.cwd, /worktrees/)
    assert.match(response.result.thread.cwd, /worktrees/)
    assert.notEqual(response.result.cwd, repo)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

class JsonLineReader {
  private buffer = ''
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(proc: ChildProcess) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.push(chunk))
  }

  next(timeoutMs = READ_TIMEOUT_MS): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = (value: any) => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        reject(new Error(`等待被测进程输出超过 ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async nextResponse(id: number, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`等待响应 ${id} 超过 ${timeoutMs}ms`)
      const msg = await this.next(Math.min(remaining, READ_TIMEOUT_MS))
      if (msg.id === id && msg.method == null) return msg
    }
  }

  private push(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    }
  }
}

class WebSocketJsonReader {
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }

  next(timeoutMs = READ_TIMEOUT_MS): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = (value: any) => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        reject(new Error(`等待被测进程输出超过 ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  async nextResponse(id: number, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`等待响应 ${id} 超过 ${timeoutMs}ms`)
      const msg = await this.next(Math.min(remaining, READ_TIMEOUT_MS))
      if (msg.id === id && msg.method == null) return msg
    }
  }
}

class TextCollector {
  private text = ''
  private waiters: Array<() => void> = []

  constructor(proc: ChildProcess) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.text += chunk
      for (const waiter of this.waiters.splice(0)) waiter()
    })
  }

  async waitFor(pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 5000
    while (!pattern.test(this.text)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${pattern}; saw: ${this.text}`)
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error(`timed out waiting for ${pattern}; saw: ${this.text}`))
        }, remaining)
        this.waiters.push(waiter)
      })
    }
  }
}

class ChildProcessDuplex extends Duplex {
  private readonly proc: ChildProcess

  constructor(proc: ChildProcess) {
    super()
    this.proc = proc
    if (!proc.stdin || !proc.stdout) throw new Error('proxy process needs stdin/stdout')
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.stdout.on('end', () => this.push(null))
    proc.on('exit', () => this.push(null))
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.proc.stdin?.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.proc.stdin?.end()
    callback()
  }
}

function json(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`
}

async function nextNotification(
  reader: JsonLineReader,
  method: string,
): Promise<{ params: Record<string, unknown> }> {
  for (let i = 0; i < 50; i += 1) {
    const message = await reader.next()
    if (message.method === method) return { params: asTestRecord(message.params) }
  }
  throw new Error(`missing notification: ${method}`)
}

function asTestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 读调试日志，等到里面有 pattern 再交出来（最多等 timeoutMs）。调试日志攒到这一轮事件循环的末尾才写
 * （util.mts 的 debugLog），同一轮里发出去的应答会先到，应答一到就读会读不到这一轮记的行
 */
async function debugLogWith(path: string, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (pattern.test(text) || Date.now() > end) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  return await Promise.race([
    once(proc, 'exit').then(([code]) => code as number | null),
    delay(timeoutMs).then(() => null),
  ])
}

function terminateWebSocket(ws: WebSocket | null): void {
  if (!ws || ws.readyState === WebSocket.CLOSED) return
  ws.on('error', () => {})
  ws.terminate()
}

async function stopProcess(proc: ChildProcess, timeoutMs = 2000): Promise<void> {
  const exited = (): boolean => proc.exitCode !== null || proc.signalCode !== null
  const wait = async (): Promise<boolean> => {
    if (exited()) return true
    return await Promise.race([
      once(proc, 'exit').then(() => true),
      delay(timeoutMs).then(() => false),
    ])
  }
  if (exited()) return
  proc.kill()
  if (await wait()) return
  proc.kill('SIGKILL')
  await wait()
}

async function waitForStderr(proc: ChildProcess, pattern: RegExp): Promise<void> {
  if (!proc.stderr) throw new Error('test process has no stderr')
  proc.stderr.setEncoding('utf8')
  let acc = ''
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
    }
    const onData = (chunk: string) => {
      acc += String(chunk)
      if (pattern.test(acc)) {
        cleanup()
        resolve()
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`process exited before stderr matched ${pattern}; saw: ${acc}`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      proc.kill()
      reject(new Error(`timed out waiting for stderr ${pattern}; saw: ${acc}`))
    }, 5000)
    proc.stderr?.on('data', onData)
    proc.once('exit', onExit)
  })
}

test('thread/list honors isPinned and metadata updates persist the pin state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const env = {
    ...isolatedEnv,
    CODEX_HOME: home,
    CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
    CHA_CLAUDE_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const first = await reader.nextResponse(1)
    const firstId = first.result.thread.id
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const second = await reader.nextResponse(2)
    const secondId = second.result.thread.id
    // 列表照上游不列还没说过话的会话：暂停的目标给它们预览
    for (const [index, threadId] of [firstId, secondId].entries()) {
      proc.stdin.write(
        json({
          id: 10 + index,
          method: 'thread/goal/set',
          params: { threadId, objective: `会话 ${index}`, status: 'paused' },
        }),
      )
      assert.equal((await reader.nextResponse(10 + index)).error, undefined)
    }

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/metadata/update',
        params: { threadId: firstId, isPinned: true },
      }),
    )
    const updated = await reader.nextResponse(3)
    assert.equal(updated.result.thread.isPinned, true)

    proc.stdin.write(json({ id: 4, method: 'thread/list', params: { isPinned: true } }))
    const pinned = await reader.nextResponse(4)
    assert.deepEqual(
      pinned.result.data.map((thread: any) => thread.id),
      [firstId],
    )

    proc.stdin.write(json({ id: 5, method: 'thread/list', params: { isPinned: false } }))
    const unpinned = await reader.nextResponse(5)
    assert.deepEqual(
      unpinned.result.data.map((thread: any) => thread.id),
      [secondId],
    )

    proc.stdin.write(json({ id: 6, method: 'thread/list', params: {} }))
    const all = await reader.nextResponse(6)
    assert.deepEqual(
      new Set(all.result.data.map((thread: any) => thread.id)),
      new Set([firstId, secondId]),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex section pin RPC moves a thread into and out of the reserved pinned section', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'threadSection/list', params: { limit: 100 } }))
    const sections = await reader.nextResponse(2)
    assert.equal(sections.error, undefined)
    const pinnedSection = sections.result.data.find(
      (section: any) => section.id === '01984de2-8f74-7c91-a3b2-5c5e937cf318',
    )
    assert.ok(pinnedSection)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/section/move',
        params: { threadId, sectionId: pinnedSection.id, beforeThreadId: null },
      }),
    )
    const moved = await reader.nextResponse(3)
    assert.equal(moved.error, undefined)
    assert.deepEqual(moved.result, {})

    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId } }))
    const pinned = await reader.nextResponse(4)
    assert.equal(pinned.result.thread.isPinned, true)
    assert.equal(pinned.result.thread.section.id, pinnedSection.id)

    proc.stdin.write(
      json({
        id: 5,
        method: 'thread/list',
        params: { sectionId: pinnedSection.id, sortKey: 'section_position' },
      }),
    )
    const pinnedList = await reader.nextResponse(5)
    assert.deepEqual(
      pinnedList.result.data.map((thread: any) => thread.id),
      [threadId],
    )

    proc.stdin.write(
      json({ id: 6, method: 'thread/section/move', params: { threadId, sectionId: null } }),
    )
    const unpinned = await reader.nextResponse(6)
    assert.equal(unpinned.error, undefined)

    proc.stdin.write(json({ id: 7, method: 'thread/read', params: { threadId } }))
    const afterUnpin = await reader.nextResponse(7)
    assert.equal(afterUnpin.result.thread.isPinned, false)
    assert.equal(afterUnpin.result.thread.section, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/settings/update preserves model and effort compatibility', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const started = await reader.nextResponse(1)
    const threadId = started.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/settings/update',
        params: {
          threadId,
          model: 'haiku',
          effort: 'xhigh',
          personality: 'friendly',
          collaborationMode: {
            mode: 'default',
            settings: { developer_instructions: 'keep settings compatibility' },
          },
        },
      }),
    )
    let updated: any = null
    let settingsNotification: any = null
    for (let attempt = 0; attempt < 20 && (!updated || !settingsNotification); attempt += 1) {
      const message = await reader.next()
      if (message.id === 2 && message.method == null) updated = message
      if (message.method === 'thread/settings/updated') settingsNotification = message
    }
    assert.ok(updated)
    assert.deepEqual(updated.result, {})
    assert.ok(settingsNotification)
    assert.equal(settingsNotification.params.threadSettings.model, 'haiku')
    assert.equal(settingsNotification.params.threadSettings.effort, 'xhigh')
    assert.equal(settingsNotification.params.threadSettings.personality, 'friendly')

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const read = await reader.nextResponse(3)
    assert.equal(read.result.model, 'haiku')
    assert.equal(read.result.reasoningEffort, 'xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread sections paginate without losing entries at page boundaries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      CHA_CLAUDE_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  let id = 0
  const request = async (method: string, params: unknown) => {
    proc.stdin.write(json({ id: ++id, method, params }))
    const response = await reader.nextResponse(id)
    assert.equal(response.error, undefined)
    return response.result
  }
  try {
    for (let i = 0; i < 201; i++) await request('threadSection/create', { name: `Section ${i}` })
    for (const limit of [1, 100, 200, 500]) {
      const seen = new Set<string>()
      let cursor: string | null = null
      let pages = 0
      do {
        assert.ok(++pages <= 202, 'pagination must make progress')
        const result = await request('threadSection/list', { limit, cursor })
        for (const section of result.data) {
          assert.equal(seen.has(section.id), false)
          seen.add(section.id)
        }
        cursor = result.nextCursor
      } while (cursor !== null)
      assert.equal(seen.size, 202)
    }
  } finally {
    proc.kill()
    await once(proc, 'exit')
    await rm(home, { recursive: true, force: true })
  }
})

test('thread/start 允许回退时，不可用的客户端默认模型换成已保存的默认模型', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-test-'))
  const directory = join(home, 'codex-harness-adapter')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'config.json'), JSON.stringify({ model: 'sonnet[1m]' }))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...isolatedEnv,
      CODEX_HOME: home,
      CHA_CLAUDE_HOME: join(home, 'codex-harness-adapter'),
      // 旧的默认模型启动时搬进 Claude 的 settings.json：用用例自己的配置目录
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CHA_CLAUDE_MOCK: '1',
      CHA_CLAUDE_MODELS: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'gpt-6-luna', allowProviderModelFallback: true },
      }),
    )
    assert.equal((await reader.nextResponse(1)).result.model, 'sonnet[1m]')
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'haiku', allowProviderModelFallback: true },
      }),
    )
    assert.equal((await reader.nextResponse(2)).result.model, 'haiku')
    proc.stdin.write(
      json({ id: 3, method: 'thread/start', params: { cwd: process.cwd(), model: 'gpt-6-luna' } }),
    )
    assert.equal((await reader.nextResponse(3)).error.code, -32602)
  } finally {
    proc.kill()
    await once(proc, 'exit')
    await rm(home, { recursive: true, force: true })
  }
})
