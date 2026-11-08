import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAxTree, newRefBook } from '../src/browser/ax.mjs'
import { createBrowserExecutor } from '../src/browser/executor.mjs'
import { createSiteBook } from '../src/browser/sites.mjs'
import type { ClientToolInvocation } from '../src/tool-port.mjs'
import { fakeHost } from './fake-cdp.mjs'

test('跨标签及文档代次的相同 backend ID 不复用 ref；变化只回两行', () => {
  const node = {
    nodeId: '1',
    backendDOMNodeId: 7,
    role: { value: 'button' },
    name: { value: 'Save' },
  }
  const a = newRefBook(),
    b = newRefBook()
  assert.notEqual(formatAxTree([node], a)[0], formatAxTree([node], b)[0])
  assert.equal(formatAxTree([node], a)[0], formatAxTree([node], a)[0])
})

test('重绘后旧 ref 只失败一次，恢复快照给新 ref；移除节点会清理引用', async () => {
  const host = fakeHost()
  const executor = createBrowserExecutor({ host, sites: createSiteBook(null) })
  let seq = 0
  const invocation: ClientToolInvocation = {
    id: 'i',
    callId: 'i',
    namespace: 'litch_browser',
    tool: '',
    arguments: {},
    device: { id: 'local', name: 'Fixture', kind: 'local', target: null },
    threadId: 's',
    turnId: 't',
    harness: null,
    cwd: null,
  }
  const call = (tool: string, args = {}) =>
    executor.call(
      {
        ...invocation,
        tool,
        arguments: args,
        callId: String(++seq),
      },
      { signal: new AbortController().signal, ask: async () => 'session' },
    )
  const text = (r: Awaited<ReturnType<typeof call>>) =>
    r.contentItems.flatMap((i) => (i.type === 'inputText' ? [i.text] : [])).join('\n')
  const ref = (r: Awaited<ReturnType<typeof call>>) => {
    const found = /\[ref=([^\]]+)\]/.exec(text(r))?.[1]
    assert.ok(found)
    return found
  }
  await call('navigate', { url: 'https://fixture.test/one' })
  const first = await call('snapshot')
  const old = ref(first)
  const page = host.pages()[0]
  assert.ok(page)
  await page.load('https://fixture.test/two', 1000)
  const stale = await call('click', { ref: old })
  assert.equal(stale.success, false)
  assert.match(text(stale), /needs_snapshot.*true/)
  const next = await call('snapshot')
  assert.equal(next.success, true, text(next))
  assert.notEqual(ref(next), old)
  assert.match(text(await call('snapshot', { diff: true })), /no changes/)
  const current = ref(next)
  const cdp = page.cdp.bind(page)
  page.cdp = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> =>
    method === 'Accessibility.getFullAXTree' ? ({ nodes: [] } as T) : cdp<T>(method, params)
  assert.match(text(await call('snapshot', { diff: true })), /- - button "OK"/)
  const removed = await call('click', { ref: current })
  assert.equal(removed.success, false)
  assert.match(text(removed), /staleRef|stale or unknown ref/)
  assert.equal(page.sent.includes('Input.dispatchMouseEvent'), false)
  executor.turnEnded({ deviceId: 'local', threadId: 's', turnId: 't' })
})
