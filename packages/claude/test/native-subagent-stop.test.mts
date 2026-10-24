import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposeScene, type Scene, startScene, until } from './fixtures/background-scene.mjs'
import type { ModelRequest } from './fixtures/mock-llm.mjs'

// 用户单独停一个子代理（stopAgent）：对子线程发 turn/interrupt，经 CLI 的 stop_task 停掉它，父会话的回合照常，
// 之后照 CLI 自己的行为收尾；不当成看门狗停的（不发“Litch 停的”那句）

const toolId = (): string => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const first = (request: ModelRequest): string =>
  JSON.stringify((request.messages as Array<Record<string, unknown>> | undefined)?.[0]?.content)

test('STOP-AGENT-001 用户停一个前台子代理：只停它，父回合拿到结果接着做完', {
  timeout: 180_000,
}, async () => {
  const scene: Scene = await startScene('native-subagent-stop')
  let released = false
  try {
    scene.model.fallback = async (request) => {
      const text = JSON.stringify(request.messages)
      if (first(request).includes('SUB_CHILD')) {
        // 子代理一直想着：直到被停（CLI 断开这次请求）
        while (!released) await sleep(100)
        return [{ type: 'text', text: 'SUB_DONE' }]
      }
      if (text.includes('tool_result')) return [{ type: 'text', text: 'MAIN_DONE' }]
      return [
        { type: 'text', text: 'MAIN_SPAWN' },
        {
          type: 'tool_use',
          id: toolId(),
          name: 'Agent',
          input: {
            description: '慢慢查',
            prompt: 'SUB_CHILD 慢慢查',
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
      ]
    }
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: 'MAIN 派一个子代理慢慢查' }],
    })
    const childStarted = () =>
      scene.client.trace.find(
        (m) => m.method === 'turn/started' && m.params.threadId !== scene.threadId,
      )?.params
    await until('子线程开了回合', () => Boolean(childStarted()))
    const child = childStarted()
    // 子代理真的在等模型了（CLI 已经登记了任务）再停
    await until('子代理在想', () =>
      scene.model.requests.some((request) => first(request).includes('SUB_CHILD')),
    )
    await sleep(500)
    assert.deepEqual(
      await scene.client.request('turn/interrupt', {
        threadId: child.threadId,
        turnId: child.turn.id,
      }),
      {},
    )
    const done = await scene.client.completed(turn.id)
    assert.equal(done.status, 'completed', '父回合照常做完')
    const main = scene.model.requests.at(-1)
    const said = JSON.stringify(main?.messages)
    assert.ok(said.includes('MAIN_SPAWN'))
    assert.doesNotMatch(said, /Litch stopped the subagent/, '不是看门狗停的')
    await until('子线程的回合收尾', () =>
      scene.client.trace.some(
        (m) =>
          m.method === 'turn/completed' &&
          m.params.threadId === child.threadId &&
          m.params.turn.id === child.turn.id,
      ),
    )
    const childDone = scene.client.trace.find(
      (m) => m.method === 'turn/completed' && m.params.threadId === child.threadId,
    )?.params.turn
    assert.equal(childDone?.status, 'interrupted', '记成被打断，不是出错')
    assert.equal(childDone?.error, null)
    // 别的子线程不存在时，再停一次：子代理已经结束，按普通的打断处理（回合已结束，什么都不做）
    assert.deepEqual(
      await scene.client.request('turn/interrupt', {
        threadId: child.threadId,
        turnId: child.turn.id,
      }),
      {},
    )
  } finally {
    released = true
    await disposeScene(scene)
  }
})
