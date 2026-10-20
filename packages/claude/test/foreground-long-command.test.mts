import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 前台的 Bash 跑得久一点（几秒以上）时，CLI 会为它发 task_started（好让用户中途转到后台），
// 但命令最后是在前台跑完的，工具结果里没有 backgroundTaskId。入口曾把它当成后台命令去跟踪，
// 条目一直停在 inProgress，界面上的“正在运行”记号一直闪，后台命令跑完的通知也永远等不到。

test('前台跑了几秒的命令照常完成，不被当成后台命令', { timeout: 120_000 }, async () => {
  const home = await realpath(await mkdtemp('/tmp/fg-long-command-'))
  const cwd = join(home, 'project')
  await mkdir(cwd, { recursive: true })
  const model = new MockLLM()
  const endpoint = await model.start()
  const client = await ProtocolClient.start(home, endpoint)
  try {
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_fg_long',
        name: 'Bash',
        input: { command: 'sleep 6 && echo FG_LONG_DONE', description: 'long foreground' },
      },
    ])
    model.enqueue(() => [{ type: 'text', text: 'DONE' }])
    const start = client.trace.length
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Run the command.' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const commands = client.trace
      .slice(start)
      .filter(
        (message) =>
          message.method === 'item/completed' && message.params.item.type === 'commandExecution',
      )
      .map((message) => message.params.item)
    assert.equal(commands.length, 1, '命令要在回合里完成')
    assert.equal(commands[0].status, 'completed')
    assert.equal(commands[0].exitCode, 0)
    assert.match(commands[0].aggregatedOutput ?? '', /FG_LONG_DONE/)
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const stored = history.thread.turns.find((entry: any) => entry.id === turn.id)
    for (const item of stored.items)
      if (item.type === 'commandExecution') assert.equal(item.status, 'completed')
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
