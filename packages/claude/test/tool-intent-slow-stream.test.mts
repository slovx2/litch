import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 一条回复里接连几个工具调用，后一个内容块要流好几秒（比如几个子代理，每个的 prompt 都很长）时，
// CLI 已经开始执行前一个调用、触发 PreToolUse 钩子，但前一个块那一行要等后一个块流完才写进会话记录。
// 钩子要是等这一行落进记录才放行，前一个调用就会被拖住甚至拒掉（曾经真实会话里三个子代理拒了两个）。
// 这里用真的 CLI：第一个 Bash 块流完后停 4.5 秒再流第二个块，两个命令都要真的执行。

const toolResults = (request: ModelRequest): Map<string, string> => {
  const results = new Map<string, string>()
  for (const message of request.messages ?? [])
    for (const block of Array.isArray(message.content) ? message.content : [])
      if (block?.type === 'tool_result')
        results.set(
          block.tool_use_id,
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        )
  return results
}

test('后一个内容块流得慢时，前一个工具调用照样执行（不被意图确认的钩子拒掉）', {
  timeout: 120_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/tool-intent-slow-'))
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
        id: 'toolu_slow_first',
        name: 'Bash',
        input: { command: 'echo FIRST > first.txt', description: 'first' },
        pauseAfterMs: 4_500,
      },
      {
        type: 'tool_use',
        id: 'toolu_slow_second',
        name: 'Bash',
        input: { command: 'echo SECOND > second.txt', description: 'second' },
      },
    ])
    let followUp: ModelRequest | undefined
    model.enqueue((request) => {
      followUp = request
      return [{ type: 'text', text: 'DONE' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Run both commands.' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.ok(followUp, '工具结果要交回模型')
    const results = toolResults(followUp)
    for (const id of ['toolu_slow_first', 'toolu_slow_second'])
      assert.doesNotMatch(results.get(id) ?? '', /禁止执行/, `${id} 不能被钩子拒绝`)
    assert.equal((await readFile(join(cwd, 'first.txt'), 'utf8')).trim(), 'FIRST')
    assert.equal((await readFile(join(cwd, 'second.txt'), 'utf8')).trim(), 'SECOND')
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
