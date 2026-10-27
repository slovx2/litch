import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 一像素的 PNG：CLI 交给模型前会读图、缩放，要是一张真的图
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 请求里所有消息的图片块 */
const imagesIn = (request: Record<string, any>): any[] =>
  (request.messages as any[]).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block: any) =>
          block.type === 'image'
            ? [block]
            : block.type === 'tool_result' && Array.isArray(block.content)
              ? block.content.filter((inner: any) => inner.type === 'image')
              : [],
        )
      : [],
  )

// 插话带图片：发成内容块交给 CLI，回合中途 CLI 把它和文字一起交给模型（以前入口只交文字，图片被拒）
test('STEER-IMAGE-001：真实 CLI 里插话带的图片，同一回合里下一次模型请求就看得到', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-steer-image-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  const entered = gate()
  const release = gate()
  try {
    client.onTool = async () => {
      entered.resolve()
      await release.promise
      return { success: true, contentItems: [{ type: 'inputText', text: 'WAITED' }] }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'function',
          name: 'wait_fixture',
          description: '等待测试信号',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    })
    model.enqueue((request) => [
      {
        type: 'tool_use',
        id: 'toolu_image_wait',
        name: request.tools.find((entry: any) =>
          entry.name.startsWith('mcp__codex_harness_adapter__'),
        ).name,
        input: {},
      },
    ])
    let seen: Record<string, any> | null = null
    model.enqueue((request) => {
      seen = request
      return [{ type: 'text', text: 'SAW_IT' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'IMAGE_TURN' }],
    })
    assert.equal(imagesIn(model.requests[0] ?? { messages: [] }).length, 0)
    await entered.promise
    await client.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: 'image-steer',
      input: [
        { type: 'text', text: 'STEER_WITH_IMAGE' },
        { type: 'image', url: `data:image/png;base64,${PIXEL}` },
      ],
    })
    release.resolve()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.ok(seen, '插话之后模型又被问了一次')
    const request = seen as Record<string, any>
    assert.match(JSON.stringify(request.messages), /STEER_WITH_IMAGE/)
    const images = imagesIn(request)
    assert.equal(images.length, 1, '插话带的图片到了模型')
    assert.equal(images[0].source?.type, 'base64')
    // 回合记录里插话那条用户消息带着图片
    const read = (await client.request('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    const steered = read.turns[0].items.filter((item: any) => item.type === 'userMessage')[1]
    assert.deepEqual(
      steered.content.map((part: any) => part.type),
      ['text', 'image'],
    )
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
