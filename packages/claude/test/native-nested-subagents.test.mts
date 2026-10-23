import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  disposeScene,
  readTurns,
  runTurn,
  startScene,
  until,
} from './fixtures/background-scene.mjs'
import type { ModelRequest } from './fixtures/mock-llm.mjs'

const toolId = (): string => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (value: string) => ({ type: 'text', text: value })
const agent = (description: string, prompt: string, foreground: boolean) => ({
  type: 'tool_use',
  id: toolId(),
  name: 'Agent',
  input: {
    description,
    prompt,
    subagent_type: 'general-purpose',
    ...(foreground ? { run_in_background: false } : {}),
  },
})

// 父子请求可能交错到达：按第一条消息归属
const first = (request: ModelRequest): string =>
  JSON.stringify((request.messages as Array<Record<string, unknown>> | undefined)?.[0]?.content)
const started = (request: ModelRequest): boolean =>
  ((request.messages as Array<Record<string, unknown>> | undefined) ?? []).some(
    (message) => message.role === 'assistant',
  )

// 子代理自己再派一个后台子代理（CLI 记成 spawnDepth 2）：那一次的启动回执没有结构化结果，只有一段文字。
// 以前把它当子代理做完了（用时 0 毫秒、结果是启动回执）；要等它真的结束
test('NESTED-001：子代理派出的后台子代理不在启动回执时当成做完，等它真的结束才收尾', {
  timeout: 120_000,
}, async () => {
  const scene = await startScene('native-nested-subagent')
  try {
    scene.model.fallback = async (request) => {
      const opening = first(request)
      if (opening.includes('NESTED_CHILD')) {
        await sleep(3_000)
        return [text('NESTED_DONE 嵌套的做完了')]
      }
      if (opening.includes('OUTER_CHILD')) {
        if (!started(request))
          return [text('OUTER_STEP'), agent('嵌套调研', 'NESTED_CHILD 慢慢查', false)]
        return [text('OUTER_DONE 外层做完了')]
      }
      assert.ok(opening.includes('NESTED_MAIN'), '收到无法归属的模型请求')
      if (!started(request))
        return [text('MAIN_START'), agent('外层调研', 'OUTER_CHILD 去查', true)]
      return [text('MAIN_DONE')]
    }
    const turn = await runTurn(scene, 'NESTED_MAIN 派一个子代理')
    assert.equal(turn.status, 'completed')
    const threads = scene.client.trace
      .filter((m) => m.method === 'thread/started' && m.params.thread.id !== scene.threadId)
      .map((m) => m.params.thread)
    const nested = threads.find((thread) => thread.name === '嵌套调研')
    assert.ok(nested, `应有嵌套子代理的子线程：${threads.map((thread) => thread.name)}`)
    await until('嵌套子代理收尾', async () =>
      scene.client.trace.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === nested.id &&
          /NESTED_DONE/.test(m.params.item.text ?? ''),
      ),
    )
    const items = (await readTurns(scene)).flatMap((entry: any) => entry.items)
    const spawn = items.find(
      (item: any) =>
        item.type === 'collabAgentToolCall' &&
        item.tool === 'spawnAgent' &&
        item.receiverThreadIds?.includes(nested.id),
    )
    assert.equal(spawn?.agentsStates?.[nested.id]?.status, 'completed')
    assert.doesNotMatch(JSON.stringify(items), /Async agent launched/, '启动回执不是子代理的结果')
  } finally {
    await disposeScene(scene)
  }
})
