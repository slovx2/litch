import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteError } from '../src/remote.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 别的地方的会话号。官方桌面端（26.1007）找一个置顶会话在哪台机器上时，向每个连着的入口都发 thread/read，
// 所以 dsh 的入口会收到 Claude Code、Pi、原生 codex 的会话号。答“这里没有”是正常的应答：
// 话术要是上游的 `thread not found: <会话号>`（桌面端按话术的开头认“这里没有”，认不出就当这台机器出了错），
// 入口的日志里也不该记成失败（桌面端隔一会儿就问一遍，以前每问一次记一行，验收时日志里一直在刷）。
// dsh 0.2.0-rc.2 对不存在的会话，session/follow 报的是 session/not-found；跟进新版本时这条先红就是它改了说法。
const FOREIGN = {
  'Pi 或原生 codex 的（UUID v7）': '0190f0a0-0000-7000-8000-000000000001',
  'Claude Code 的（UUID v4）': '4fd706ec-2f05-4c31-a44a-a198aa16c1a0',
  '像 dsh 的、但 dsh 没有': 'session-00000000-0000-4000-8000-000000000000',
}

/** 把入口往标准错误里记的行收下来（入口的运行日志就是它） */
function capture(): { lines: string[]; restore(): void } {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.error = original) }
}

test('dsh：别处的会话号答“这里没有”，话术照上游，不记成失败；真的失败照记', {
  timeout: 120000,
}, async () => {
  const env = await isolate([])
  const server = new DshServer(join(env.root, 'home'))
  const log = capture()
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    for (const [what, id] of Object.entries(FOREIGN))
      for (const method of ['thread/read', 'thread/resume'])
        await assert.rejects(
          desktop.call(method, { threadId: id, includeTurns: false }),
          (error: any) =>
            error.code === -32602 && error.message === `${method}: thread not found: ${id}`,
          `${what}：${method}`,
        )
    for (const id of Object.values(FOREIGN)) {
      assert.equal(server.live.has(id), false, '没有的会话不留在内存里')
      assert.equal(server.subscriptions.has(id), false, '没有的会话谁也没订阅上')
    }
    assert.deepEqual(log.lines, [], '答“这里没有”不记成失败')

    // 自己的会话照常读得到；别的失败照记，同是 -32602 的也一样
    assert.equal((await desktop.call('thread/read', { threadId: thread.id })).thread.id, thread.id)
    await assert.rejects(
      desktop.call('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '起个标题' }],
        outputSchema: { type: 'object' },
      }),
      (error: any) => error.code === -32602,
    )
    assert.deepEqual(log.lines, ['[dsh] turn/start 失败（-32602）: dsh 入口暂不支持严格结构化输出'])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    log.restore()
    await server.close()
    await env.restore()
  }
})

test('dsh：打开会话时 dsh 那边别的失败（连接断了）照原样报、照记', { timeout: 30000 }, async () => {
  const env = await isolate([])
  const server = new DshServer(join(env.root, 'home'))
  // 不起 dsh：打开会话的那条流直接以“连接断了”收场，和 dsh 半路退出时一样
  ;(server as any).remote = async () => ({
    version: '0.2.0-rc.2',
    open: (_endpoint: string, _args: unknown, _item: unknown, end: (error: Error) => void) => {
      setImmediate(() => end(new RemoteError('socket', 'dsh 连接已断开')))
      return () => {}
    },
  })
  const log = capture()
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const id = 'session-00000000-0000-4000-8000-000000000001'
    await assert.rejects(
      desktop.call('thread/read', { threadId: id }),
      (error: any) => error.code === -32602 && error.message === 'thread/read: dsh 连接已断开',
    )
    assert.deepEqual(log.lines, ['[dsh] thread/read 失败（-32602）: dsh 连接已断开'])
  } finally {
    log.restore()
    await server.close()
    await env.restore()
  }
})
