import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import { TOOL_IMAGE_PREFIX, toolImagesOf } from '../../protocol/src/tool-images.mjs'
import { ToolImages } from '../src/tool-images.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig } from './helpers.mjs'

function png(color = 25): Buffer {
  const image = new PNG({ width: 320, height: 200 })
  image.data.fill(color)
  return PNG.sync.write(image)
}
const bytes = png()
const data = bytes.toString('base64')
const block = { type: 'image', mimeType: 'image/png', data }
const mcp = (id: string, content: unknown[]) => ({
  type: 'mcpToolCall',
  id,
  tool: 'Read',
  server: 'test',
  result: { content },
  status: 'completed',
})

test('工具图片：Claude/MCP/Pi/ACP/OpenCode/inputImage/input_image 统一资产，缩略图、去重和重启恢复', async () => {
  const home = await mkdtemp(join(tmpdir(), 'litch-tool-images-'))
  let enabled = true
  let assets = new ToolImages(home, () => enabled)
  try {
    const variants: unknown[] = [
      block,
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      { type: 'inputImage', imageUrl: `data:image/png;base64,${data}` },
      { type: 'input_image', image_url: `data:image/png;base64,${data}` },
    ]
    let first = ''
    for (const [i, image] of variants.entries()) {
      const item: any =
        i < 2
          ? mcp(String(i), [image])
          : {
              type: i === 2 ? 'dynamicToolCall' : 'functionCallOutput',
              id: String(i),
              tool: 'screenshot',
              ...(i === 2 ? { contentItems: [image] } : { output: [image] }),
            }
      await assets.decorate({ threadId: 'thread', item }, 'pi:')
      const refs = toolImagesOf(item.litchToolImages)
      assert.equal(refs.length, 1)
      assert.equal(refs[0]!.width, 320)
      assert.equal(refs[0]!.thumbnail!.width, 160)
      assert.equal(refs[0]!.thumbnail!.height, 100)
      assert.equal(JSON.stringify(item).includes(data), false, '原图不可随条目传输')
      first ||= refs[0]!.id
      assert.equal(refs[0]!.id, first)
    }
    assets.close()
    assets = new ToolImages(home, () => enabled)
    const history: any = { thread: { id: 'thread', turns: [{ items: [mcp('0', [])] }] } }
    await assets.decorate(history, 'pi:')
    assert.equal(history.thread.turns[0].items[0].litchToolImages[0].id, first)
    assert.deepEqual(await assets.read(TOOL_IMAGE_PREFIX + first), {
      kind: 'ready',
      format: 'image',
      bytes: bytes.length,
      dataBase64: data,
    })
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => assets.read(TOOL_IMAGE_PREFIX + first)),
    )
    assert.equal(concurrent.filter((result) => result.kind === 'ready').length, 4)
    assert.equal(concurrent.filter((result) => result.kind === 'busy').length, 1)
    enabled = false
    const off: any = { threadId: 'thread', item: mcp('0', [block]) }
    await assets.decorate(off, 'pi:')
    assert.equal(off.item.litchToolImages, undefined)
    assert.deepEqual(off.item.result.content, [])
    assert.deepEqual(await assets.read(TOOL_IMAGE_PREFIX + first), { kind: 'unsupported' })
  } finally {
    assets.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('imageView按ChatGPT路径读取并绑定首次内容，文件后来变化不替换历史', async () => {
  const home = await mkdtemp(join(tmpdir(), 'litch-tool-view-'))
  const assets = new ToolImages(home, () => true)
  try {
    const path = join(home, 'capture.png')
    await writeFile(path, bytes)
    const item: any = { type: 'imageView', id: 'view', path }
    await assets.decorate({ threadId: 't', item }, 'codex:')
    const id = item.litchToolImages[0].id
    await writeFile(path, png(100))
    const history: any = { type: 'imageView', id: 'view', path }
    await assets.decorate({ threadId: 't', item: history }, 'codex:')
    assert.equal(history.litchToolImages[0].id, id)
    assert.equal(((await assets.read(TOOL_IMAGE_PREFIX + id)) as any).dataBase64, data)
    assert.deepEqual(await assets.read(TOOL_IMAGE_PREFIX + '../capture.png'), { kind: 'invalid' })
  } finally {
    assets.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('坏图、超限、远端URL和用户附件不进入工具资产；原始图片块不泄漏', async () => {
  const home = await mkdtemp(join(tmpdir(), 'litch-tool-limit-'))
  const assets = new ToolImages(home, () => true)
  try {
    const huge = Buffer.from(bytes)
    huge.writeUInt32BE(20000, 16)
    const bad = [
      { ...block, data: 'bad' },
      { ...block, data: huge.toString('base64') },
      { type: 'inputImage', imageUrl: 'https://example.test/private.png' },
    ]
    for (const [i, b] of bad.entries()) {
      const item: any = mcp(`bad-${i}`, [b])
      await assets.decorate({ item }, 'claude:t')
      assert.equal(item.litchToolImages, undefined)
      assert.deepEqual(item.result.content, [])
    }
    const user = { type: 'userMessage', id: 'user', content: [block] }
    assert.equal(await assets.decorate({ item: user }, 'claude:t'), false)
    assert.equal(user.content[0], block)
  } finally {
    assets.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('最终连接能力闸：实时/历史仅声明方收到引用，未声明方标准形状不变，原图需双能力', async () => {
  const pi = new FakeUpstream('pi', [
    { id: 'pictures', updatedAt: 1, turns: [{ id: 'turn', items: [mcp('read', [block])] }] },
  ])
  pi.handlers['thread/read'] = () => ({
    thread: {
      id: 'pictures',
      updatedAt: 1,
      turns: [{ id: 'turn', items: [mcp('read', [block])] }],
    },
  })
  const env = rig({ pi })
  try {
    const ui = env.connect(),
      plain = env.connect()
    await ui.initialize(['harness', 'toolImages', 'mediaImages'])
    await plain.initialize(['harness', 'mediaImages'])
    const result = await ui.call('thread/read', { threadId: 'pictures', includeTurns: true })
    const shown = result.thread.turns[0].items[0]
    assert.equal(shown.result.content.length, 0)
    assert.equal(shown.litchToolImages.length, 1)
    const original = await plain.call('thread/read', { threadId: 'pictures', includeTurns: true })
    assert.equal(original.thread.turns[0].items[0].result.content[0].data, data)
    assert.equal(original.thread.turns[0].items[0].litchToolImages, undefined)
    const source = TOOL_IMAGE_PREFIX + shown.litchToolImages[0].id
    assert.equal((await ui.call('litch/media/readImage', { source })).dataBase64, data)
    assert.equal(
      (await plain.fails('litch/media/readImage', { source })).data.litch,
      'extensionRequired',
    )
    pi.notify('item/completed', {
      threadId: 'pictures',
      turnId: 'turn',
      item: mcp('live', [block]),
    })
    const live = await ui.waitFor((frame) => frame.method === 'item/completed')
    assert.equal((live.params as any).item.litchToolImages[0].id, shown.litchToolImages[0].id)
    assert.equal((live.params as any).item.result.content.length, 0)
    pi.handlers['thread/turns/list'] = () => ({
      data: [{ id: 'turn', items: [mcp('read', [])] }],
      nextCursor: null,
    })
    const page = await ui.call('thread/turns/list', { threadId: 'pictures', cursor: null })
    assert.equal(
      page.data[0].items[0].litchToolImages[0].id,
      shown.litchToolImages[0].id,
      '分页必须沿用同会话资产绑定',
    )
  } finally {
    await env.close()
  }
})

test('关闭隐私设置时历史和rawResponseItem均不能传图，模型原始上游帧不被改写', async () => {
  const pi = new FakeUpstream('pi', [{ id: 'off', updatedAt: 1 }])
  pi.handlers['thread/read'] = () => ({
    thread: { id: 'off', turns: [{ id: 't', items: [mcp('read', [block])] }] },
  })
  const env = rig({ pi }, {}, { clientToolSettings: { 'privacy.toolImages': false } })
  try {
    const ui = env.connect()
    await ui.initialize(['harness', 'toolImages', 'mediaImages'])
    const read = await ui.call('thread/read', { threadId: 'off', includeTurns: true })
    assert.deepEqual(read.thread.turns[0].items[0].result.content, [])
    assert.equal(read.thread.turns[0].items[0].litchToolImages, undefined)
    const raw = {
      threadId: 'off',
      item: {
        type: 'function_call_output',
        call_id: 'read',
        output: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }],
      },
    }
    pi.notify('rawResponseItem/completed', raw)
    const note = await ui.waitFor((frame) => frame.method === 'rawResponseItem/completed')
    assert.deepEqual((note.params as any).item.output, [])
    assert.equal(raw.item.output.length, 1)
  } finally {
    await env.close()
  }
})
