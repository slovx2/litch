// 连接池本身（native-mcp-pool.mts）：不起 CLI，直接用桥接对着手写的 stdio 服务连、放回、再连。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeMcpBridge } from '../src/native-mcp-bridge.mjs'
import { mcpPoolLimits, NativeMcpPool } from '../src/native-mcp-pool.mjs'
import { countedServers, countServer } from './fixtures/mcp-count.mjs'

async function withLog(run: (log: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-pool-'))
  try {
    await run(join(home, 'counted.jsonl'))
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

// 一个“CLI 进程”的一生：租用、用完放回
async function session(pool: NativeMcpPool, thread: string, servers: unknown): Promise<void> {
  const bridge = new NativeMcpBridge(pool, thread)
  await bridge.connect(servers, process.cwd(), {}, new AbortController().signal)
  await bridge.close()
}

const pids = async (log: string) =>
  (await countedServers(log)).map(({ pid, closed }) => ({ pid, closed }))

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等不到预期的状态')
    await new Promise((done) => setTimeout(done, 20))
  }
}

test('MCP-024：配置项的缺省值与非法值', () => {
  assert.deepEqual(mcpPoolLimits({}), { idleMs: 600_000, maxIdle: 16 })
  assert.deepEqual(
    mcpPoolLimits({ CHA_CLAUDE_MCP_IDLE_MINUTES: '0.5', CHA_CLAUDE_MCP_IDLE_CONNECTIONS: '3' }),
    { idleMs: 30_000, maxIdle: 3 },
  )
  assert.deepEqual(
    mcpPoolLimits({ CHA_CLAUDE_MCP_IDLE_MINUTES: '-1', CHA_CLAUDE_MCP_IDLE_CONNECTIONS: 'x' }),
    { idleMs: 600_000, maxIdle: 16 },
  )
  assert.equal(new NativeMcpPool({ idleMs: 0, maxIdle: 16 }).enabled, false)
  assert.equal(new NativeMcpPool({ idleMs: 1_000, maxIdle: 0 }).enabled, false)
})

test('MCP-024：同一线程再租拿到同一条；没人用的连接超过上限时先关最久没用的', async () => {
  await withLog(async (log) => {
    const pool = new NativeMcpPool({ idleMs: 60_000, maxIdle: 1 })
    const servers = { counted: countServer(log) }
    try {
      await session(pool, 't1', servers)
      await session(pool, 't1', servers)
      assert.equal((await pids(log)).length, 1)
      await session(pool, 't2', servers)
      await eventually(async () => (await pids(log))[0]?.closed === true)
      assert.deepEqual(pool.snapshot(), [{ thread: 't2', name: 'counted', taken: false }])
      assert.deepEqual(
        (await pids(log)).map(({ closed }) => closed),
        [true, false],
      )
    } finally {
      await pool.close()
    }
    await eventually(async () => (await pids(log)).every(({ closed }) => closed))
  })
})

test('MCP-024：配置指纹变了就重建，旧的关掉；配置里没了的服务也关掉', async () => {
  await withLog(async (log) => {
    const pool = new NativeMcpPool({ idleMs: 60_000, maxIdle: 16 })
    const base = countServer(log)
    try {
      await session(pool, 't1', { counted: base })
      await session(pool, 't1', { counted: { ...base, env: { ...base.env, MARKER: '2' } } })
      await eventually(async () => (await pids(log))[0]?.closed === true)
      assert.equal((await pids(log)).length, 2)
      await session(pool, 't1', {})
      await eventually(async () => (await pids(log))[1]?.closed === true)
      assert.deepEqual(pool.snapshot(), [])
    } finally {
      await pool.close()
    }
  })
})

test('MCP-024：线程关闭时正被用的连接不回池，用完就关', async () => {
  await withLog(async (log) => {
    const pool = new NativeMcpPool({ idleMs: 60_000, maxIdle: 16 })
    try {
      const bridge = new NativeMcpBridge(pool, 't1')
      await bridge.connect(
        { counted: countServer(log) },
        process.cwd(),
        {},
        new AbortController().signal,
      )
      await pool.closeThread('t1')
      assert.deepEqual(pool.snapshot(), [])
      assert.equal((await pids(log))[0]?.closed, false)
      await bridge.close()
      await eventually(async () => (await pids(log))[0]?.closed === true)
    } finally {
      await pool.close()
    }
  })
})

test('MCP-024：没给连接池（管理操作）就现连现关', async () => {
  await withLog(async (log) => {
    const bridge = new NativeMcpBridge()
    await bridge.connect(
      { counted: countServer(log) },
      process.cwd(),
      {},
      new AbortController().signal,
    )
    await bridge.client('counted').ping()
    await bridge.close()
    await eventually(async () => (await pids(log))[0]?.closed === true)
  })
})
