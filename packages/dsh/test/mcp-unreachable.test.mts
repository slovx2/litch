import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { HARNESS_CONFIG_METHOD as M } from '../../protocol/src/harness-config.mjs'
import { dshHome } from '../src/runtime.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 用户的 profile 补丁里有连不上的 MCP（HTTP 型指向没人听的端口、stdio 型的命令不存在）时，会话照常建、回合照常跑完，
// 模型只是看不到那几个服务的工具。Claude 入口出过同类问题：一个 HTTP MCP 连不上（fetch failed），整个回合 0 毫秒失败。
// 对着 dsh 0.2.0-rc.2：dsh-mcp-client 默认（failOnStartupError: false）连不上只在后台重试，插件照样是 active；
// 设了 failOnStartupError: true 的那一行插件激活失败（failed），dsh 本身和别的插件照常。

/** 一个此刻没人听的回环端口：先占住拿到号，再放掉 */
async function deadPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const row = (name: string, config: string[]): string[] => [
  `    - id: mcp-${name}`,
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  `        serverName: ${name}`,
  ...config.map((line) => `        ${line}`),
]

test('MCP-DSH-001：profile 补丁里的 MCP 连不上，会话照建、回合照常完成，模型拿不到它们的工具', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) => [
    { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
  ])
  const port = await deadPort()
  const home = dshHome()
  assert.equal(home, join(env.root, 'home', 'dsh-home'), '前提：测试的 DSH_HOME 在临时目录里')
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(
    join(home, 'profiles/web/cordis.patch.yml'),
    [
      '- insert:',
      ...row('deadhttp', ['transport: streamable-http', `url: http://127.0.0.1:${port}/mcp`]),
      ...row('deadstrict', [
        'transport: streamable-http',
        `url: http://127.0.0.1:${port}/mcp`,
        'failOnStartupError: true',
      ]),
      ...row('deadstdio', ['transport: stdio', `command: ${join(env.root, 'no-such-mcp-server')}`]),
      '',
    ].join('\n'),
  )
  const server = new DshServer(join(env.root, 'home'))
  const desktop = client(server)
  try {
    await desktop.call('initialize', {
      clientInfo: { name: 'test', version: '0' },
      capabilities: { litchExtensions: [EXTENSION.harnessConfig] },
    })
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    const done = await desktop.until(
      'turn/completed',
      (params) => params.threadId === thread.id && params.turn.id === turn.id,
    )
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    // 不是一开跑就失败的那种：模型真的收到了带工具的请求、回了话
    const asked = env.model.requests.filter((body) => body.tools?.length)
    assert.ok(asked.length > 0, '模型应收到带工具的请求')
    const tools: string[] = asked.at(-1).tools.map((tool: any) => tool.name)
    assert.ok(
      !tools.some((name) => name.startsWith('mcp__dead')),
      `连不上的服务不该有工具：${tools.join(',')}`,
    )
    assert.ok(
      desktop.notifications.some(
        (one) =>
          one.method === 'item/completed' &&
          one.params.turnId === turn.id &&
          one.params.item.type === 'agentMessage' &&
          String(one.params.item.text).includes('好的'),
      ),
      '应有模型的回答',
    )
    // dsh 确实加载了这几行：默认的照样 active，failOnStartupError 的那一行激活失败（说明真去连过、连不上）
    const plugins = await (await server.remote()).rpc('pluginManager/listPlugins', {})
    const phase = (id: string) => plugins.find((one: any) => one.patchId === id)?.fiberPhase
    assert.deepEqual(
      [phase('mcp-deadhttp'), phase('mcp-deadstdio'), phase('mcp-deadstrict')],
      ['active', 'active', 'failed'],
    )
    // 设置页读得出来，激活失败的那一行标成失败
    const read = await desktop.call(M.mcpRead, { harness: 'dsh' })
    const state = (name: string) => read.servers.find((one: any) => one.name === name)?.status
    assert.equal(state('deadstrict')?.state, 'failed')
    assert.deepEqual(read.servers.map((one: any) => one.name).sort(), [
      'deadhttp',
      'deadstdio',
      'deadstrict',
    ])
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})
