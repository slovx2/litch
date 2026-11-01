// 桥接交给 CLI 的工具清单（native-mcp-bridge.mts）：不起 CLI，直接连上桥接给出的那一份看清单。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { sdkMcpServers } from '../src/mcp-config.mjs'
import { NativeMcpBridge } from '../src/native-mcp-bridge.mjs'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'

test('MCP 工具清单原样转交：服务没声明常驻的不替它标，声明了的照留', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-tool-list-'))
  const log = join(home, 'counted.jsonl')
  const server = countServer(log, ['pinned', 'lazy'], ['lazy'])
  const bridge = new NativeMcpBridge(null, 't1')
  let client: Client | null = null
  // 收场按先后来（t.after 按登记的顺序跑）：先断开、关桥接，等服务子进程记下“关了”那一行，再删目录；
  // 先删目录的话，子进程退出前往已经删掉的目录里写记录会报错
  t.after(async () => {
    await client?.close()
    await bridge.close()
    for (let tries = 0; tries < 250; tries++) {
      if ((await countedServers(log)).every((entry) => entry.closed)) break
      await delay(20)
    }
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const servers = await bridge.connect(
    { counted: server },
    process.cwd(),
    {},
    new AbortController().signal,
  )
  const [transport, remote] = InMemoryTransport.createLinkedPair()
  await servers.counted!.instance.connect(remote)
  client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool._meta?.['anthropic/alwaysLoad'] ?? null]),
    [
      ['pinned', true],
      ['lazy', null],
    ],
  )
  // 配置里也不替服务定常驻
  assert.equal('alwaysLoad' in sdkMcpServers({ counted: server }).counted, false)
})
