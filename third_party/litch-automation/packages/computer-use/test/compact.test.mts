import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerExecutor } from '../src/executor.mjs'

test('大树默认压缩，完整读取与分页可达，截断后不漏掉未见变化', async () => {
  const requests: Record<string, unknown>[] = []
  const body = Array.from(
    { length: 600 },
    (_, i) =>
      `[${i + 1}] Button "Fixture settings row ${i} with a long but useful accessible name"`,
  ).join('\n')
  const helper = {
    async request(method: string, params: Record<string, unknown> = {}) {
      if (method === 'permissions') return { accessibility: true, screenRecording: true }
      requests.push(params)
      return {
        app: { name: 'Fixture', bundleId: 'test.fixture' },
        window: { title: 'Fixture' },
        screenshot: { width: 10, height: 10, mime: 'image/png', data: '' },
        text: body,
        diff: false,
      }
    },
  }
  const executor = createComputerExecutor({
    helper: {
      client: async () => helper,
      connected: helper,
      restart: async () => {},
    },
  })
  let seq = 0
  const call = (args: Record<string, unknown>) =>
    executor.call(
      {
        id: 'c',
        callId: String(++seq),
        device: { id: 'd' },
        threadId: 's',
        turnId: 't',
        namespace: 'litch_computer',
        tool: 'get_app_state',
        arguments: { app: 'test.fixture', ...args },
      },
      { signal: new AbortController().signal, ask: async () => 'decline' },
    )
  const text = (r: Awaited<ReturnType<typeof call>>) => (r.contentItems[0] as { text: string }).text
  const compact = text(await call({}))
  const full = text(await call({ detail: 'full' }))
  assert.ok(compact.length < full.length / 3)
  assert.match(compact, /next_offset/)
  assert.match(full, /Fixture settings row 599/)
  const offset = JSON.parse(compact.split('\n').find((l) => l.startsWith('{"observation":'))!)
    .observation.next_offset
  assert.match(text(await call({ offset })), /Fixture settings row/)
  await call({})
  assert.equal(requests.at(-1)!.full, true)
  console.log(JSON.stringify({ fixture: 'cu-state', before: full.length, after: compact.length }))
})
