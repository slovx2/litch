import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractImageInputs, textFromInput } from '../src/util.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('fileId 图片不可读取时保留正文与明确提示，不把标识解释为 URL 或路径', () => {
  for (const fileId of ['file-image-1', '/etc/private.png', 'https://example.invalid/image.png']) {
    const input = [
      { type: 'text', text: '保留正文' },
      { type: 'image', fileId },
    ]
    const result = extractImageInputs(input)
    assert.equal(result.images.length, 0)
    assert.match(result.textPrompt, /^保留正文\n/)
    assert.match(result.textPrompt, /图片内容不可用.*无法解析 fileId/)
    assert.ok(!result.textPrompt.includes(fileId))
    assert.equal(textFromInput(input), result.textPrompt)
  }
})

test('真实 SDK 收到 fileId 不可读提示，正文及后续回合完成，重启保留附件标识', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-image-reference-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const input = [
    { type: 'text', text: 'FILEID_BODY_CONTINUES', text_elements: [] },
    { type: 'image', fileId: 'file-unavailable-1' },
  ]
  try {
    model.enqueue((request) => {
      const user = request.messages.findLast((message: { role: string }) => message.role === 'user')
      const content = JSON.stringify(user.content)
      assert.match(content, /FILEID_BODY_CONTINUES/)
      assert.match(content, /图片内容不可用.*无法解析 fileId/)
      assert.doesNotMatch(content, /"type":"image"/)
      return [{ type: 'text', text: 'FILEID_BODY_OK' }]
    })
    model.enqueue(() => [{ type: 'text', text: 'NEXT_TURN_OK' }])
    const { thread } = await client.request('thread/start', { cwd: home })
    const first = await client.request('turn/start', { threadId: thread.id, input })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续处理下一条正文', text_elements: [] }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    await client.close()
    client = await ProtocolClient.start(home, url)
    const restored = await client.request('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
    const saved = restored.thread.turns.find((turn: { id: string }) => turn.id === first.turn.id)
    assert.ok(saved)
    assert.deepEqual(
      saved.items.find((item: { type: string }) => item.type === 'userMessage').content,
      input,
    )
    assert.equal(model.requests.length, 2)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
