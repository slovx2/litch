import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import { TOOL_IMAGE_PREFIX } from '../../protocol/src/tool-images.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { codexRig } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { TestClient } from './helpers.mjs'

const image = new PNG({ width: 320, height: 200 })
image.data.fill(70)
const data = PNG.sync.write(image).toString('base64')
const block = { type: 'image', mimeType: 'image/png', data }
const item = (id: string, content: unknown[]) => ({
  type: 'mcpToolCall',
  id,
  server: 'fixture',
  tool: 'read_image',
  status: 'completed',
  result: { content },
})

for (const remote of [false, true])
  for (const enabled of [true, false])
    test(`工具图片恢复首屏：${remote ? '套接字转发' : '直连'}，图片设置${enabled ? '开启' : '关闭'}`, async () => {
      const fake = new FakeCodex()
      const stored = codexThread(98, 400, { status: { type: 'idle' }, turns: [] })
      fake.threads.push(stored)
      // 同一条目实时有图、历史不再带图；首屏必须找回同会话的首次绑定。
      // 另一条首屏才出现的原始图也须提取/剥离；用户附件保持原样。
      const turns = [
        {
          id: 'turn',
          items: [
            item('live', []),
            item('history-only', [block]),
            { type: 'userMessage', id: 'user', content: [block] },
          ],
        },
      ]
      fake.handlers['thread/resume'] = () => ({
        thread: { ...stored, turns: [] },
        initialTurnsPage: { data: turns, nextCursor: null },
      })
      fake.handlers['thread/turns/list'] = () => ({ data: turns, nextCursor: null })
      const env = codexRig({ fake, toolSettings: { 'privacy.toolImages': enabled } })
      const socket = join(env.stateDir, 'relay.sock')
      const server = remote ? await listenUnix(socket, (wire) => env.device.attach(wire)) : null
      const clients: TestClient[] = []
      const connect = async (declared: boolean) => {
        const client = remote ? await TestClient.overSocket(socket) : env.connect()
        clients.push(client)
        await client.initialize(['harness', 'mediaImages', ...(declared ? ['toolImages'] : [])])
        return client
      }
      try {
        let ui = await connect(true)
        const plain = await connect(false)
        await ui.call('thread/resume', { threadId: stored.id })
        await plain.call('thread/resume', { threadId: stored.id })
        fake.notify('item/completed', {
          threadId: stored.id,
          turnId: 'turn',
          item: item('live', [block]),
        })
        const live = await ui.waitFor((frame) => frame.method === 'item/completed')
        const refs = (live.params as any).item.litchToolImages
        assert.equal(refs?.length, enabled ? 1 : undefined)
        assert.deepEqual((live.params as any).item.result.content, [])
        ui.close()
        ui = await connect(true)
        const params = {
          threadId: stored.id,
          excludeTurns: true,
          initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
        }
        const resumed = await ui.call('thread/resume', params)
        const page = await ui.call('thread/turns/list', { threadId: stored.id })
        assert.deepEqual(resumed.thread.turns, [])
        const items = resumed.initialTurnsPage.data[0].items
        assert.deepEqual(items[0].litchToolImages, refs, '首屏必须用正确会话找回已保存的图片')
        assert.deepEqual(items, page.data[0].items, '首屏和独立分页装饰一致')
        assert.deepEqual(items[1].result.content, [], '首屏原始大图必须剥离，包括隐私关闭时')
        assert.equal(items[1].litchToolImages?.length, enabled ? 1 : undefined)
        assert.deepEqual(items[2].content, [block], '不遍历用户附件')
        if (enabled) {
          const read = await ui.call('litch/media/readImage', {
            source: TOOL_IMAGE_PREFIX + refs[0].id,
          })
          assert.equal(read.dataBase64, data)
        }
        const original = await plain.call('thread/resume', params)
        assert.deepEqual(original.initialTurnsPage.data, turns, '未声明连接保留标准形状与原始内容')
        assert.ok(!plain.raw.some((raw) => raw.includes('litchToolImages')))
        const upstream = turns[0]?.items[1]
        assert.ok(upstream && 'result' in upstream)
        assert.deepEqual(upstream.result.content, [block], '上游帧不能被原地改写')
      } finally {
        for (const client of clients) client.close()
        await server?.close()
        await env.close()
      }
    })
