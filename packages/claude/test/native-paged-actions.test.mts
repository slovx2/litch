import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { disposeScene, readTurns, runTurn, say } from './fixtures/background-scene.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 真 CLI 加假模型：分页只控制显示，不得改变原生会话里供分叉、回退使用的历史。
test('分页重开、分叉和早期回退保留正确的显示历史及模型上下文', {
  timeout: 240_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'paged-actions-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  const { thread } = await client.request('thread/start', {
    cwd: home,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  const scene = { home, workspace: home, model, client, threadId: thread.id as string }
  const inputs = Array.from({ length: 14 }, (_, i) => `PAGE_INPUT_${i}_END`)
  const ids: string[] = []
  const pageParams = { limit: 10, sortDirection: 'desc', itemsView: 'full' }
  const resume = (threadId: string) =>
    scene.client.request('thread/resume', {
      threadId,
      excludeTurns: true,
      initialTurnsPage: pageParams,
    })
  const texts = (turns: any[]): string[] =>
    turns.flatMap((turn) =>
      turn.items
        .filter((item: any) => item.type === 'userMessage')
        .flatMap((item: any) => item.content.map((part: any) => part.text)),
    )
  const expectContext = (kept: number) => {
    scene.model.enqueue((request) => {
      const context = JSON.stringify(request.messages)
      inputs.forEach((input, index) => {
        assert.equal(context.includes(input), index < kept, `模型历史边界错位：${input}`)
      })
      return [{ type: 'text', text: '历史核对通过' }]
    })
  }
  try {
    for (const [i, input] of inputs.entries()) {
      scene.model.enqueue(say(`PAGE_ANSWER_${i}_END`))
      const turn = await runTurn(scene, input)
      assert.equal(turn.status, 'completed')
      ids.push(turn.id)
    }
    // 真正关闭入口再打开，首屏只有十回合，旧页仍能逐字取回。
    await scene.client.close()
    scene.client = await ProtocolClient.start(scene.home, url)
    const reopened = await resume(scene.threadId)
    assert.deepEqual(reopened.thread.turns, [])
    assert.deepEqual(texts([...reopened.initialTurnsPage.data].reverse()), inputs.slice(4))
    const older = await scene.client.request('thread/turns/list', {
      threadId: scene.threadId,
      cursor: reopened.initialTurnsPage.nextCursor,
      ...pageParams,
    })
    assert.equal(older.nextCursor, null)
    assert.deepEqual(texts([...older.data].reverse()), inputs.slice(0, 4))

    // 客户端仅拿最近十回合时，在第十二回合分叉，服务端仍须带走头十二回合。
    await resume(scene.threadId)
    const fork = await scene.client.request('thread/fork', {
      threadId: scene.threadId,
      lastTurnId: ids[11],
      excludeTurns: true,
    })
    assert.deepEqual(fork.thread.turns, [])
    const branch = { ...scene, threadId: fork.thread.id }
    const forkPage = await resume(branch.threadId)
    assert.equal(forkPage.initialTurnsPage.data.length, 10)
    assert.deepEqual(texts(await readTurns(branch)), inputs.slice(0, 12))
    assert.deepEqual(texts(await readTurns(scene)), inputs)
    expectContext(12)
    assert.equal((await runTurn(branch, '检查分叉上下文')).status, 'completed')

    // 目标在首屏之外，按 ID 回退到第三回合之前，再像编辑重发一样发送替换消息。
    await resume(scene.threadId)
    await scene.client.request('thread/revert', {
      threadId: scene.threadId,
      beforeTurnId: ids[2],
    })
    assert.deepEqual(texts(await readTurns(scene)), inputs.slice(0, 2))
    expectContext(2)
    assert.equal((await runTurn(scene, '编辑第三回合')).status, 'completed')
    assert.deepEqual(texts(await readTurns(scene)), [...inputs.slice(0, 2), '编辑第三回合'])
  } finally {
    await disposeScene(scene)
  }
})
