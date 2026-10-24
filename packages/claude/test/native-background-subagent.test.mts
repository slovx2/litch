import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  backgroundBash,
  disposeScene,
  runTurn,
  type Scene,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import type { ModelRequest } from './fixtures/mock-llm.mjs'

// 后台命令还在跑，下一回合派了个前台子代理、子代理一步一步出新的动作条目：
// 父会话的集合里那条后台命令一直算在跑（输入框上方那一行不能在这时没了）

const toolId = (): string => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const first = (request: ModelRequest): string =>
  JSON.stringify((request.messages as Array<Record<string, unknown>> | undefined)?.[0]?.content)
const steps = (request: ModelRequest): number =>
  ((request.messages as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (message) => message.role === 'assistant',
  ).length

const declaring = { litchExtensions: ['backgroundTasks'] }

// 声明了扩展的连接看到的会话对象、回合多出我们的字段：校验上游结构时去掉
function standardView(method: string, _kind: string, payload: any): unknown {
  if (method.startsWith('litch/')) return undefined
  const copy = structuredClone(payload)
  const strip = (thread: any) => {
    if (!thread || typeof thread !== 'object') return
    delete thread.litchBackground
    for (const turn of thread.turns ?? []) delete turn.litchOrigin
  }
  strip(copy?.thread)
  for (const entry of copy?.data ?? []) {
    strip(entry)
    delete entry?.litchOrigin
  }
  delete copy?.turn?.litchOrigin
  return copy
}

test('BG-SUB-001 后台命令在跑时前台子代理一步步出条目：父会话的集合里它一直在跑', {
  timeout: 180_000,
}, async () => {
  const scene: Scene = await startScene('native-bg-subagent', {}, declaring)
  scene.client.standardView = standardView
  const command = uniqueSleep(60)
  try {
    scene.model.enqueue(backgroundBash('toolu_bgsub', command))
    scene.model.enqueue(say('已在后台启动'))
    await runTurn(scene, 'BG_MAIN 在后台启动一条长命令')
    const read = await scene.client.request('thread/read', { threadId: scene.threadId })
    const task = read.thread.litchBackground.tasks[0]
    assert.equal(task.status, 'running')
    const mark = scene.client.trace.length

    scene.model.fallback = async (request) => {
      const opening = first(request)
      if (opening.includes('SUB_CHILD')) {
        const done = steps(request)
        if (done < 4) {
          await sleep(400)
          return [
            { type: 'text', text: `SUB_STEP ${done}` },
            {
              type: 'tool_use',
              id: toolId(),
              name: 'Bash',
              input: { command: `echo step-${done}`, description: `step ${done}` },
            },
          ]
        }
        return [{ type: 'text', text: 'SUB_DONE' }]
      }
      if (steps(request) === 0 || !JSON.stringify(request.messages).includes('SUB_DONE'))
        return [
          { type: 'text', text: 'MAIN_SPAWN' },
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Agent',
            input: {
              description: '一步步查',
              prompt: 'SUB_CHILD 一步步查',
              subagent_type: 'general-purpose',
              run_in_background: false,
            },
          },
        ]
      return [{ type: 'text', text: 'MAIN_DONE' }]
    }
    const reads: string[] = []
    let polling = true
    const poll = (async () => {
      while (polling) {
        const now = await scene.client.request('thread/read', { threadId: scene.threadId })
        const mine = now.thread.litchBackground?.tasks?.find((one: any) => one.id === task.id)
        reads.push(mine?.status ?? 'missing')
        await sleep(100)
      }
    })()
    const turn = await runTurn(scene, 'BG_MAIN 派一个子代理一步步查')
    polling = false
    await poll
    assert.equal(turn.status, 'completed')
    await until('子代理出过几条命令', () =>
      scene.client.trace
        .slice(mark)
        .some((m) => m.method === 'item/completed' && m.params.threadId !== scene.threadId),
    )
    const trace = scene.client.trace.slice(mark)
    const changes = trace
      .filter((m) => m.method === 'litch/thread/background/changed')
      .map((m) => m.params)
    // 父会话的会话对象没有被一条不带集合的 thread/started 整个换掉
    assert.equal(
      trace.some((m) => m.method === 'thread/started' && m.params.thread.id === scene.threadId),
      false,
    )
    for (const change of changes.filter((one) => one.threadId === scene.threadId))
      assert.equal(
        change.tasks.find((one: any) => one.id === task.id)?.status,
        'running',
        '新回合里发出的集合仍把后台命令算在跑',
      )
    assert.deepEqual([...new Set(reads)], ['running'], '回合进行中读到的会话对象上它一直在跑')
  } finally {
    await disposeScene(scene)
  }
})
