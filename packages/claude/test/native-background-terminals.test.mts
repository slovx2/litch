import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('真实 CLI 的后台 Bash 可在本轮内列出、结束与清理', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-background-terminals-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const held = deferred()
  try {
    const { thread } = await client.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_bg_sleep',
        name: 'Bash',
        input: { command: 'sleep 30', run_in_background: true, description: 'background sleep' },
      },
    ])
    // 模型保持本轮进行，后台 shell 存活期间才能列出；停止任务可能触发额外的模型请求。
    model.enqueue(async () => {
      await held.promise
      return [{ type: 'text', text: '后台任务已处理' }]
    })
    model.enqueue(() => [{ type: 'text', text: '收到后台任务通知' }])
    model.enqueue(() => [{ type: 'text', text: '收到后台任务通知' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '启动后台任务' }],
    })

    const list = async () =>
      (await client.request('thread/backgroundTerminals/list', { threadId: thread.id })) as {
        data: Array<Record<string, unknown>>
        nextCursor: string | null
      }
    let listed = await list()
    // 任务先出现在列表里、稍后才关联上工具调用：SDK 的“任务集合变化”与“任务已启动”是两条消息，
    // 先后不保证。夹在中间的那次列出拿到的是按任务 ID 生成的临时进程号，等关联上再核对。
    const linked = () => listed.data[0]?.processId === 'claude:toolu_bg_sleep'
    for (let attempt = 0; attempt < 100 && !linked(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      listed = await list()
    }
    assert.equal(listed.data.length, 1, JSON.stringify({ errors: model.unexpected }))
    const terminal = listed.data[0]!
    assert.equal(terminal.processId, 'claude:toolu_bg_sleep')
    assert.equal(terminal.command, 'sleep 30')
    assert.equal(terminal.cwd, workspace)
    const commandItem = client.trace.find(
      (message) =>
        message.method === 'item/started' &&
        message.params?.item?.type === 'commandExecution' &&
        message.params.item.processId === 'claude:toolu_bg_sleep',
    )
    assert.ok(commandItem, '后台 Bash 必须有对应的命令条目')
    assert.equal(terminal.itemId, commandItem.params.item.id)

    const terminated = await client.request('thread/backgroundTerminals/terminate', {
      threadId: thread.id,
      processId: 'claude:toolu_bg_sleep',
    })
    assert.deepEqual(terminated, { terminated: true })
    for (let attempt = 0; attempt < 50 && (await list()).data.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(await list(), { data: [], nextCursor: null })
    assert.deepEqual(
      await client.request('thread/backgroundTerminals/terminate', {
        threadId: thread.id,
        processId: 'claude:toolu_bg_sleep',
      }),
      { terminated: false },
    )
    assert.deepEqual(
      await client.request('thread/backgroundTerminals/clean', { threadId: thread.id }),
      {},
    )

    held.resolve()
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', client.stderr.slice(-3000))
    assert.deepEqual(await list(), { data: [], nextCursor: null })
  } finally {
    held.resolve()
    await client.close()
    await model.close?.()
    await rm(home, { recursive: true, force: true })
  }
})
