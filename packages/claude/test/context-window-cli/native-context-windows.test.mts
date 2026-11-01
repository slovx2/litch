// 真实 CLI 只解析配置并返回 summary，不发模型请求，不使用真实账号。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  providerLaunch,
  withFlagSettings,
  writeProviderConfig,
  writeProviderSecret,
} from '../../src/claude-provider.mjs'
import { contextWindowsPath } from '../../src/context-windows.mjs'
import { hostClaudeVersion } from '../../src/host-claude.mjs'
import {
  backgroundBash,
  cliProcesses,
  commandAlive,
  disposeScene,
  listTerminals,
  readTurns,
  runTurn,
  say,
  startScene,
  uniqueSleep,
  until,
} from '../fixtures/background-scene.mjs'
import { requiredClaudeCli } from '../fixtures/claude-cli.mjs'
import { isolatedEnv } from '../fixtures/isolated-env.mjs'
import { reclaimAtEnd } from '../fixtures/reclaim.mjs'

test('CTX-CLI-001：账号 flagSettings 与托管供应商均保留用户 env 500K 覆盖；转默认后按模型 400K/200K', {
  timeout: 90_000,
}, async () => {
  const cli = requiredClaudeCli()
  hostClaudeVersion(cli, '2.1.299')
  const root = await mkdtemp(join(tmpdir(), 'lcw-'))
  const saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CHA_CLAUDE_HOME: process.env.CHA_CLAUDE_HOME,
  }
  const proxy = createServer((_req, res) => res.writeHead(503).end())
  proxy.on('connect', (_req, socket) => socket.destroy())
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const clean = reclaimAtEnd(() => {
    proxy.closeAllConnections()
    proxy.close()
  })
  try {
    for (const provider of ['anthropic', 'work']) {
      for (const global of [true, false]) {
        const home = join(root, `${provider}-${global}`)
        const claude = join(home, 'claude')
        await mkdir(claude, { recursive: true })
        process.env.CLAUDE_CONFIG_DIR = claude
        process.env.CHA_CLAUDE_HOME = join(home, 'adapter')
        await mkdir(process.env.CHA_CLAUDE_HOME, { recursive: true })
        writeProviderConfig({
          last: null,
          removed: [],
          providers: {
            work: {
              kind: 'apiKey',
              title: 'Work',
              baseUrl: url,
              authHeader: 'apiKey',
              smallModel: null,
              models: [],
            },
          },
        })
        writeProviderSecret('work', 'isolated-fake-key')
        await writeFile(
          contextWindowsPath(),
          JSON.stringify({
            [provider]: { 'claude-opus-4-6': 400000, 'claude-sonnet-4-6': 200000 },
          }),
        )
        await writeFile(
          join(claude, 'settings.json'),
          JSON.stringify(
            global
              ? { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }
              : { autoCompactWindow: 500000 },
          ),
        )
        const launch = providerLaunch(provider, 'claude-opus-4-6[1m]', {
          ...isolatedEnv,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: claude,
          CLAUDE_CODE_TMPDIR: join(root, 'ct'),
          HTTPS_PROXY: url,
          HTTP_PROXY: url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        })
        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        const abortController = new AbortController()
        const timer = setTimeout(() => abortController.abort(), 20000)
        const q = query({
          prompt: {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                await held
                return { done: true, value: undefined }
              },
            }),
          },
          options: {
            pathToClaudeCodeExecutable: cli,
            env: launch.env,
            cwd: home,
            abortController,
            settingSources: ['user'],
            model: 'claude-opus-4-6[1m]',
            settings: withFlagSettings({}, launch),
          },
        })
        const reclaim = reclaimAtEnd(() => {
          clearTimeout(timer)
          release()
          q.close()
        })
        try {
          await q.supportedModels()
          const opus = await q.getContextUsage({ detail: 'summary' })
          assert.equal(opus.rawMaxTokens, global ? 500000 : 400000, `${provider}: opus`)
          assert.equal(
            (opus as unknown as { autocompactSource: string }).autocompactSource,
            global ? 'env' : 'settings',
          )
          await q.applyFlagSettings({ model: 'claude-sonnet-4-6[1m]' })
          const sonnet = await q.getContextUsage({ detail: 'summary' })
          assert.equal(sonnet.rawMaxTokens, global ? 500000 : 200000, `${provider}: sonnet`)
        } finally {
          clearTimeout(timer)
          release()
          q.close()
          reclaim()
        }
      }
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    proxy.closeAllConnections()
    proxy.close()
    clean()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('CTX-CLI-002：窗口更新不停止后台命令，任务结束后的下一回合使用新窗口', {
  timeout: 90_000,
}, async () => {
  const scene = await startScene('lcw-bg', {
    CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '60',
    CHA_CLAUDE_CROSS_SESSION_INBOX: '0',
  })
  const reclaim = reclaimAtEnd(() => disposeScene(scene))
  const path = join(scene.home, 'adapter', 'context-windows.json')
  const command = uniqueSleep(60)
  try {
    await writeFile(path, JSON.stringify({ native: { 'claude-sonnet-4-6': 150000 } }))
    scene.model.enqueue(backgroundBash('toolu_context_hold', command))
    scene.model.enqueue(say('后台命令已启动'))
    assert.equal((await runTurn(scene, '启动后台命令')).status, 'completed')
    await until('后台命令仍存活', () => commandAlive(command))
    const before = cliProcesses(scene).map((row) => row.pid)
    assert.equal(before.length, 1)
    await writeFile(path, JSON.stringify({ native: { 'claude-sonnet-4-6': 100000 } }))
    scene.model.enqueue(say('窗口更新暂缓'))
    assert.equal((await runTurn(scene, '继续下一回合')).status, 'completed')
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      before,
    )
    assert.equal(commandAlive(command), true)
    const usages = () =>
      scene.client.trace
        .filter((message) => message.method === 'thread/tokenUsage/updated')
        .map((message) => message.params.tokenUsage.modelContextWindow)
    assert.equal(usages().at(-1), 150000)
    scene.model.fallback = say('后台命令已结束')
    const terminals = await listTerminals(scene)
    await scene.client.request('thread/backgroundTerminals/terminate', {
      threadId: scene.threadId,
      processId: terminals[0]?.processId,
    })
    await until('后台命令结束', () => !commandAlive(command))
    await until(
      '后台续跑完成',
      async () => !(await readTurns(scene)).some((turn) => turn.status === 'inProgress'),
    )
    assert.equal((await runTurn(scene, '验证新窗口')).status, 'completed')
    assert.equal(usages().at(-1), 100000)
  } finally {
    await disposeScene(scene)
    reclaim()
  }
})

test('CTX-CLI-003：显式 100K 窗口对假模型的 90K usage 触发真实 CLI 自动压缩', {
  timeout: 60_000,
}, async () => {
  const scene = await startScene('lcw-compact', {
    CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '60',
    CHA_CLAUDE_CROSS_SESSION_INBOX: '0',
  })
  const reclaim = reclaimAtEnd(() => disposeScene(scene))
  try {
    await writeFile(
      join(scene.home, 'adapter', 'context-windows.json'),
      JSON.stringify({ native: { 'claude-sonnet-4-6': 100000 } }),
    )
    // CLI 保留最近的消息组；先留下已完成的一组，后续才有可总结的助手历史。
    scene.model.enqueue(say('前一任务已经完成'))
    assert.equal((await runTurn(scene, '记录已完成任务')).status, 'completed')
    scene.model.enqueue(() => ({
      content: [{ type: 'text', text: '需要保留的上下文' }],
      usage: { input_tokens: 90000, output_tokens: 100 },
    }))
    scene.model.fallback = say('已保留任务目标和上下文，继续处理。')
    // 给实际历史足够长度，避免把伪造 usage 的差额全算成无法总结的系统提示前缀。
    assert.equal(
      (await runTurn(scene, '第一轮记录上下文\n' + 'x'.repeat(280000))).status,
      'completed',
    )
    assert.equal((await runTurn(scene, '继续处理')).status, 'completed')
    assert.ok(
      scene.client.trace.some(
        (message) =>
          message.method === 'item/completed' && message.params.item?.type === 'contextCompaction',
      ),
      `应由 CLI 自动压缩并完成压缩条目：${JSON.stringify({ requests: scene.model.requests.length, items: scene.client.trace.filter((message) => message.method === 'item/completed').map((message) => message.params.item?.type) })}`,
    )
    const usages = scene.client.trace.filter(
      (message) => message.method === 'thread/tokenUsage/updated',
    )
    assert.equal(usages.at(-1)?.params.tokenUsage.modelContextWindow, 100000)
    assert.ok(scene.model.requests.length >= 3, '普通回答之外还应有摘要请求')
  } finally {
    await disposeScene(scene)
    reclaim()
  }
})
