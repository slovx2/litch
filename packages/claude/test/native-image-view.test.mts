// 模型用 Read 看图时，照上游 codex 的 view_image 另有一个 imageView 条目（path 是绝对路径），
// 实时发 item/started、item/completed，存进回合（thread/read 全量视图有、摘要视图没有）；读的不是图就没有。
// 读原生会话的历史（native-history.mts）也画出同样的条目。
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { projectNativeHistory } from '../src/native-history.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 16×16 的红色 PNG：CLI 的 Read 会认出是图，把它作为图片块交给模型
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (data: Buffer) => {
    let c = 0xffffffff
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(16, 0)
  header.writeUInt32BE(16, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from('ff0000'.repeat(16), 'hex')])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(16).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('IMAGE-VIEW-001：模型 Read 一张图，另有一个 imageView 条目；Read 文字文件没有', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-image-view-'))
  const image = join(home, 'history-image.png')
  const notes = join(home, 'notes.txt')
  await writeFile(image, png())
  await writeFile(notes, '只是文字\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_image', name: 'Read', input: { file_path: image } },
      { type: 'tool_use', id: 'toolu_notes', name: 'Read', input: { file_path: notes } },
    ])
    model.enqueue(() => [{ type: 'text', text: '图片已查看' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '查看图片' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
    const views = (method: string) =>
      client.trace
        .filter((x) => x.method === method && x.params.item?.type === 'imageView')
        .map((x) => x.params.item)
    assert.equal(views('item/started').length, 1)
    const completed = views('item/completed')
    assert.equal(completed.length, 1)
    assert.equal(completed[0].path, image)
    // Read 自己的那条工具条目照旧
    const reads = client.trace.filter(
      (x) => x.method === 'item/completed' && x.params.item?.type === 'mcpToolCall',
    )
    assert.equal(reads.length, 2)
    const read = async (itemsView: string) =>
      (await client.request('thread/turns/list', { threadId: thread.id, itemsView })).data[0]
        .items as any[]
    assert.deepEqual(
      (await read('full')).filter((item) => item.type === 'imageView'),
      [completed[0]],
    )
    assert.equal(
      (await read('summary')).some((item) => item.type === 'imageView'),
      false,
    )
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('IMAGE-VIEW-002：读原生会话的历史时，Read 到图的那次调用也画出 imageView', () => {
  const user = (uuid: string, content: unknown) => ({
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content },
  })
  const assistant = (uuid: string, content: unknown) => ({
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'assistant', id: `msg_${uuid}`, content },
  })
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
  const history = projectNativeHistory(
    'thread-1',
    [
      user('u1', '查看图片'),
      assistant('a1', [
        { type: 'tool_use', id: 'toolu_image', name: 'Read', input: { file_path: '/w/a.png' } },
        { type: 'tool_use', id: 'toolu_text', name: 'Read', input: { file_path: '/w/a.txt' } },
        { type: 'tool_use', id: 'toolu_bad', name: 'Read', input: { file_path: '/w/b.png' } },
      ]),
      user('u2', [
        { type: 'tool_result', tool_use_id: 'toolu_image', content: [image] },
        { type: 'tool_result', tool_use_id: 'toolu_text', content: '只是文字' },
        { type: 'tool_result', tool_use_id: 'toolu_bad', content: [image], is_error: true },
      ]),
      assistant('a2', [{ type: 'text', text: '图片已查看' }]),
    ] as any,
    '/w',
  )
  const views = history.turns.flatMap((turn) => turn.items).filter((i) => i.type === 'imageView')
  assert.deepEqual(
    views.map((item) => (item.type === 'imageView' ? item.path : null)),
    ['/w/a.png'],
  )
})
