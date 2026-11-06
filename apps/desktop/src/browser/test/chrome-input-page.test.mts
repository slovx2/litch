import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ChromeGrant,
  ChromeRequest,
  ChromeTabState,
} from '../../../../../packages/protocol/src/chrome-browser.mjs'
import type { ChromeBridge } from '../../chrome-browser/bridge.mjs'
import { ChromePage } from '../../chrome-browser/page.mjs'

for (const inputReceipts of [false, true]) {
  test(`输入回执能力协商：${inputReceipts ? '新扩展恢复单标签观察' : '商店旧扩展仍取原结果'}`, async () => {
    const tab: ChromeTabState = {
      id: 1,
      url: 'https://example.com/a',
      title: 'Fixture',
      loading: false,
      generation: 1,
    }
    const grant: ChromeGrant = {
      leaseId: 'lease',
      tabId: 1,
      owner: { deviceId: 'local', threadId: 'thread', turnId: 'turn' },
      origins: ['https://example.com'],
      expiresAt: Date.now() + 15000,
      original: true,
      keep: true,
    }
    const calls: Array<Omit<ChromeRequest, 'kind' | 'id' | 'epoch'>> = []
    const bridge = {
      instances: () => [{ id: 'instance', inputReceipts }],
      call: async (_id: string, request: Omit<ChromeRequest, 'kind' | 'id' | 'epoch'>) => {
        calls.push(request)
        if (request.op === 'refresh') return { ...tab, generation: 2, url: 'https://example.com/b' }
        if (request.op === 'list') return [tab]
        return request.args.inputReceipt === true
          ? {
              inputReceipt: true,
              value: { ack: true },
              documentChanged: true,
              tab: { ...tab, generation: 2, url: 'https://example.com/b' },
            }
          : { ack: true }
      },
    } as unknown as ChromeBridge
    const page = new ChromePage('chrome:test', 'instance', grant, tab, bridge)
    page.bind(new AbortController().signal, 1)
    assert.deepEqual(await page.cdp('Input.dispatchKeyEvent', { key: 'Enter' }), { ack: true })
    assert.equal(calls[0]?.args.inputReceipt, inputReceipts ? true : undefined)
    if (inputReceipts) {
      await assert.rejects(
        page.cdp('Input.dispatchKeyEvent', { key: 'Enter' }),
        /Remaining input was not replayed/,
      )
      assert.equal(calls.length, 1)
    }
    await page.prepareObservation()
    assert.equal(calls[1]?.op, inputReceipts ? 'refresh' : 'list')
    await page.cdp('Page.getFrameTree')
    assert.equal(calls[2]?.generation, inputReceipts ? 2 : 1)
    page.valid = false
    await assert.rejects(page.prepareObservation(), /revoked/)
    assert.equal(calls.length, 3)
  })
}
