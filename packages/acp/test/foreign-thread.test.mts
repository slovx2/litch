import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 别的地方的会话号。官方桌面端找一个置顶会话在哪台机器上时，向每个连着的入口都发 thread/read，
// 所以 ACP 的入口会收到别的 harness 的会话号。答“这里没有”是正常的应答：话术照上游 `thread not found: <会话号>`，
// 不记成失败，也不为这个去起 agent（Gemini 冷启动要好几秒，桌面端隔一会儿就问一遍）。
const FOREIGN = {
  'Pi 或原生 codex 的（UUID v7）': '0190f0a0-0000-7000-8000-000000000001',
  'Claude Code 的（UUID v4）': '4fd706ec-2f05-4c31-a44a-a198aa16c1a0',
  'opencode 的': 'ses_1234567890abcdefABCDEF',
  临时线程: 'ephemeral-00000000-0000-4000-8000-000000000000',
}

function capture(): { lines: string[]; restore(): void } {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.error = original) }
}

test('别处的会话号答“这里没有”，话术照上游，不记成失败，不起 agent', async () => {
  const env = await isolate()
  const server = new AcpServer(env.home, env.env)
  const log = capture()
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    for (const [what, id] of Object.entries(FOREIGN))
      for (const method of ['thread/read', 'thread/resume', 'thread/turns/list'])
        await assert.rejects(
          desktop.call(method, { threadId: id, includeTurns: false }),
          (error: any) =>
            error.code === -32602 && error.message === `${method}: thread not found: ${id}`,
          `${what}：${method}`,
        )
    assert.deepEqual(await env.received(), [], '没起 agent')
    for (const id of Object.values(FOREIGN)) {
      assert.equal(server.live.has(id), false, '没有的会话不留在内存里')
      assert.equal(server.subscriptions.has(id), false, '没有的会话谁也没订阅上')
    }
    assert.deepEqual(log.lines, [], '答“这里没有”不记成失败')

    // agent 起着、又能列会话时，清单里也没有的照样答“这里没有”
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const id = FOREIGN['opencode 的']
    await assert.rejects(
      desktop.call('thread/read', { threadId: id }),
      (error: any) => error.message === `thread/read: thread not found: ${id}`,
    )
    // 自己的会话照常读得到；别的失败照记
    assert.equal((await desktop.call('thread/read', { threadId: thread.id })).thread.id, thread.id)
    await assert.rejects(
      desktop.call('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '起个标题' }],
        outputSchema: { type: 'object' },
      }),
      (error: any) => error.code === -32602,
    )
    assert.deepEqual(log.lines, [
      '[acp] turn/start 失败（-32602）: ACP agent 不支持严格结构化输出（outputSchema）',
    ])
    assert.deepEqual([...violations], [])
  } finally {
    log.restore()
    await server.close()
    await env.restore()
  }
})
