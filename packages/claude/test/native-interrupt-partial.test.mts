import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { projectNativeHistory } from '../src/native-history.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 用户在回合中途点停止：之前的工具调用和写了一半的回答都要留在回合里（实时、读会话、重开进程以后都一样），
// 客户端才有东西可摊开（被打断的回合不收起，规矩在核心的 processSettled）。
// 模型先调一次命令，再写一段字、写完这一块后停住不收尾，这时打断。

const PARTIAL = '先看了一下目录，接下来要改的是'

const itemsOf = (turn: any) =>
  turn.items.map((item: any) =>
    item.type === 'commandExecution'
      ? ['command', item.status, item.aggregatedOutput?.trim()]
      : item.type === 'agentMessage'
        ? ['message', item.text]
        : [item.type],
  )

test('INTERRUPT-PARTIAL-001：真实 CLI 打断后，命令和写了一半的回答都在回合里，重开进程也在', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-interrupt-partial-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  try {
    model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_look', name: 'Bash', input: { command: 'echo 看过了' } },
    ])
    // 字写出去以后停住：回答这一块已经发完，整条消息还没收尾
    model.enqueue(() => [{ type: 'text', text: PARTIAL, pauseAfterMs: 30_000 }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '看看目录再改' }],
    })
    const written = () =>
      client.trace
        .filter((entry) => entry.method === 'item/agentMessage/delta')
        .map((entry) => entry.params.delta)
        .join('')
    const deadline = Date.now() + 20_000
    while (!written().includes(PARTIAL)) {
      assert.ok(Date.now() < deadline, '回答的字没流出来')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'interrupted')
    const expected = [['userMessage'], ['command', 'completed', '看过了'], ['message', PARTIAL]]
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const live = read.thread.turns.find((entry: any) => entry.id === turn.id)
    assert.equal(live.status, 'interrupted')
    assert.deepEqual(itemsOf(live), expected, '打断后读会话')

    // CLI 自己的记录（读别处开的会话时画的就是它）：写了一半的那段和打断的标记都在，画出来一样
    // 用例的 HOME 里只有这一个会话
    const projects = join(home, 'claude', 'projects')
    const [project = ''] = await readdir(projects)
    const [file = ''] = (await readdir(join(projects, project))).filter((name) =>
      name.endsWith('.jsonl'),
    )
    const record = await readFile(join(projects, project, file), 'utf8')
    const messages = record
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'user' || entry.type === 'assistant')
    const native = projectNativeHistory(thread.id, messages, home).turns.at(-1)
    assert.equal(native?.status, 'interrupted')
    assert.deepEqual(itemsOf(native).slice(1), expected.slice(1), '读 CLI 自己的记录')

    await client.close()
    client = await ProtocolClient.start(home, url)
    const resumed = await client.request('thread/resume', { threadId: thread.id })
    const reopened = resumed.thread.turns.find((entry: any) => entry.id === turn.id)
    assert.equal(reopened.status, 'interrupted')
    assert.deepEqual(itemsOf(reopened), expected, '重开进程后恢复会话')
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
