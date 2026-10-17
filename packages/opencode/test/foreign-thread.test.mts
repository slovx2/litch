import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OpencodeServer } from '../src/server.mjs'
import { client, isolate, skip, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 别处的会话号。官方桌面端找一个置顶会话在哪台机器上时，向每个连着的入口都发 thread/read，
// 所以 OpenCode 的入口会收到 Claude Code、Pi、dsh、原生 codex 的会话号。答“这里没有”是正常应答：
// 话术是上游的 `thread not found: <会话号>`，入口的日志里也不记成失败。
const FOREIGN = {
  'Pi 或原生 codex 的（UUID v7）': '0190f0a0-0000-7000-8000-000000000001',
  'Claude Code 的（UUID v4）': '4fd706ec-2f05-4c31-a44a-a198aa16c1a0',
  'dsh 的': 'session-00000000-0000-4000-8000-000000000000',
}
// 像 OpenCode 的、但 OpenCode 没有（要问过 OpenCode 才知道）
const MISSING = 'ses_00000000000000000000000000'

function capture(): { lines: string[]; restore(): void } {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.error = original) }
}

const notFound = (method: string, id: string) => (error: any) =>
  error.code === -32602 && error.message === `${method}: thread not found: ${id}`

test('OpenCode：别处的会话号不起 OpenCode 就答“这里没有”，不记成失败', {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cha-opencode-foreign-'))
  const server = new OpencodeServer(join(root, 'home'))
  const log = capture()
  try {
    const desktop = client(server)
    await desktop.initialize()
    for (const [what, id] of Object.entries(FOREIGN))
      for (const method of ['thread/read', 'thread/resume', 'turn/start'])
        await assert.rejects(
          desktop.call(method, { threadId: id, includeTurns: false, input: [] }),
          notFound(method, id),
          `${what}：${method}`,
        )
    assert.equal(server.runtime.current(), null, '没有为别处的会话号起 OpenCode')
    assert.deepEqual(log.lines, [], '答“这里没有”不记成失败')
  } finally {
    log.restore()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：像 OpenCode 的会话号但它那里没有，同样答“这里没有”；别的失败照记', {
  skip,
  timeout: 60000,
}, async () => {
  const env = await isolate(scripted({}))
  const log = capture()
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    for (const method of ['thread/read', 'thread/resume'])
      await assert.rejects(desktop.call(method, { threadId: MISSING }), notFound(method, MISSING))
    assert.equal(env.server.live.has(MISSING), false, '没有的会话不留在内存里')
    assert.equal(env.server.subscriptions.has(MISSING), false, '没有的会话谁也没订阅上')
    assert.deepEqual(log.lines, [])

    // 自己的会话照常读得到；别的失败照记
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    assert.equal((await desktop.call('thread/read', { threadId: thread.id })).thread.id, thread.id)
    await assert.rejects(
      desktop.call('turn/start', { threadId: thread.id, input: [] }),
      (error: any) => error.code === -32602,
    )
    assert.equal(log.lines.length, 1)
    assert.match(String(log.lines[0]), /^\[opencode\] turn\/start 失败（-32602）: /)
  } finally {
    log.restore()
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
