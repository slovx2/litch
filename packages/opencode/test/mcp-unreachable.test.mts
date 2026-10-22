import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 用户级配置里有连不上的 MCP（地址类的端口没人听、命令类的程序不存在）：会话照常建、回合照常跑完，
// MCP 设置页读得出它们失败的状态。Claude 入口曾因此整回合 0 毫秒失败（fetch failed）。

/** 先占一个回环端口再放掉，拿到一个当下没人听的端口 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('OpenCode：配置里有连不上的 MCP 时会话照常建、回合照常完成', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(scripted({ HELLO: [[{ type: 'text', chunks: ['照常回答。'] }]] }))
  try {
    const port = await freePort()
    const file = join(env.root, 'xdg', 'config', 'opencode', 'opencode.json')
    const config = JSON.parse(await readFile(file, 'utf8'))
    config.mcp = {
      'dead-remote': { type: 'remote', url: `http://127.0.0.1:${port}/mcp`, oauth: false },
      'dead-local': { type: 'local', command: [join(env.root, 'no-such-mcp-binary')] },
    }
    await writeFile(file, JSON.stringify(config))

    const desktop = client(env.server, ['harnessConfig'])
    await desktop.initialize()
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('HELLO 你好'),
    })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.items.at(-1).text, '照常回答。')
    assert.ok(env.model.requests.length > 0, '请求到了模型')

    const read = await desktop.call('litch/harness/mcp/read', { harness: 'opencode' })
    const byName = Object.fromEntries(read.servers.map((entry: any) => [entry.name, entry]))
    assert.equal(byName['dead-remote']?.status?.state, 'failed')
    assert.equal(byName['dead-local']?.status?.state, 'failed')
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
