import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contextWindowsPath } from '../src/context-windows.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

test('旧 CLI 正常完成回合，仅去掉自动压缩窗口，同会话同版本只提示一次，切换或升级后重新判断', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-fallback-')))
  const keys = [
    'CHA_CLAUDE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CHA_CLAUDE_CLI',
    'CHA_CLAUDE_CROSS_SESSION_INBOX',
  ] as const
  const before = keys.map((key) => process.env[key])
  const runtime = new NativeClaudeRuntime()
  const options: Record<string, any>[] = []
  Reflect.set(runtime, 'sdk', {
    query: async function* (args: { options: Record<string, any> }) {
      options.push(args.options)
      yield { type: 'result', subtype: 'success', result: 'done' }
    },
  })
  const context: RuntimeTurnContext = {
    threadId: 'thread',
    turnId: 'turn',
    prompt: 'hello',
    cwd: root,
    runtimeType: null,
    model: 'claude-opus-4-6',
    provider: 'anthropic',
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    outputFormat: null,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
  }
  const events: RuntimeEvent[] = []
  const run = async () => {
    await runtime.runTurn(
      { ...context, turnId: `turn-${options.length}` },
      {
        onEvent: async (event) => {
          events.push(event)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
        onUserInputRequest: async () => ({ answers: {} }),
      },
    )
    await runtime.closeSession(context.threadId, '测试回合结束')
  }
  const warnings = () =>
    events.filter((event) => event.type === 'notice' && event.message.includes('2.1.299'))
  const cli = join(root, 'claude')
  const other = join(root, 'another-claude')
  const write = (path: string, version: string) =>
    writeFile(path, `#!/bin/sh\necho '${version} (Claude Code)'\n`, { mode: 0o700 })
  try {
    process.env.CHA_CLAUDE_HOME = root
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    process.env.CHA_CLAUDE_CLI = cli
    process.env.CHA_CLAUDE_CROSS_SESSION_INBOX = '0'
    await mkdir(process.env.CLAUDE_CONFIG_DIR)
    await writeFile(
      contextWindowsPath(),
      JSON.stringify({ anthropic: { 'claude-opus-4-6': 300000 } }),
    )
    await write(cli, '2.1.287')
    await write(other, '2.1.288')
    await run()
    await run()
    assert.equal(options.length, 2)
    assert.equal(events.filter((event) => event.type === 'completed').length, 2)
    assert.equal(options[0]!.settings.modelSettings, undefined)
    assert.equal(options[0]!.permissionMode, 'default')
    assert.equal(options[0]!.settings.apiKeyHelper, '')
    assert.equal(warnings().length, 1)
    assert.match(JSON.stringify(warnings()), /2\.1\.287.*claude.*设备详情/)
    process.env.CHA_CLAUDE_CLI = other
    await run()
    assert.equal(warnings().length, 2)
    await write(other, '2.1.290')
    await run()
    assert.equal(warnings().length, 3)
    await write(other, '2.1.318')
    await run()
    assert.equal(warnings().length, 3)
    assert.equal(
      options.at(-1)!.settings.modelSettings['claude-opus-4-6'].autoCompactWindow,
      300000,
    )
    await write(other, '2.1.290')
    await run()
    assert.equal(warnings().length, 4)
  } finally {
    await runtime.closeSession(context.threadId, '测试结束')
    for (const [index, key] of keys.entries()) {
      if (before[index] === undefined) delete process.env[key]
      else process.env[key] = before[index]
    }
    await rm(root, { recursive: true, force: true })
  }
})
