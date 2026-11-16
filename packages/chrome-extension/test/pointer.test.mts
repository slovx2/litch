import assert from 'node:assert/strict'
import test from 'node:test'
import type { AutomationPointerSample } from '../../automation-contracts/src/automation-surface.mjs'
import type { ChromeGrant } from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { planPointer, pointerCommand } from '../src/pointer.mjs'
import type { ExtensionState } from '../src/state.mjs'

function fixture() {
  const grant = {
    leaseId: 'lease',
    tabId: 1,
    expiresAt: Date.now() + 15_000,
    owner: { deviceId: 'd', threadId: 't', turnId: 'r' },
    origins: ['https://fixture.test'],
  } as ChromeGrant
  let sample: AutomationPointerSample | undefined
  let revision = 1
  let url = 'https://fixture.test/'
  let documentId = 'doc'
  let onPoll = () => {}
  const surface = () => ({
    surfaceId: 'chrome:1',
    executorId: 'epoch',
    generation: 0,
    geometryRevision: revision,
    kind: 'browserViewport',
    width: 800,
    height: 600,
  })
  const state = {
    epoch: 'epoch',
    grants: new Map([['lease', grant]]),
    generations: new Map(),
    stopped: false,
    paused: new Set(),
    stoppedTurns: new Set(),
    pointerSource: 'install()',
    chrome: {
      tabs: { get: async () => ({ url, status: 'complete' }) },
      webNavigation: { getAllFrames: async () => [{ url, frameId: 0, documentId }] },
      debugger: {
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } }
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
          const expression = String(params.expression)
          if (expression === '__litchChromePointer.geometry()')
            return { result: { value: { surface: surface() } } }
          if (expression.startsWith('__litchChromePointer.prepare(')) {
            sample = JSON.parse(expression.slice('__litchChromePointer.prepare('.length, -1))
            return { result: { value: { sample, result: 'pending' } } }
          }
          if (expression === '__litchChromePointer.arrival()') {
            onPoll()
            return { result: { value: { sample, result: 'pending' } } }
          }
          return { result: { value: true } }
        },
      },
    },
  } as unknown as ExtensionState
  return {
    state,
    grant,
    poll(fn: () => void) {
      onPoll = fn
    },
    resize() {
      revision++
    },
    navigate() {
      documentId = 'new'
    },
    crossOrigin() {
      url = 'https://unapproved.test/'
    },
  }
}

test('页面帧与计时器都不回调时，指针等待降级后只派发一次', async () => {
  const f = fixture()
  await planPointer(f.state, f.grant, 20, 20)
  let dispatched = 0
  await pointerCommand(
    f.state,
    f.grant,
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 20, y: 20 },
    async () => {
      dispatched++
    },
  )
  assert.equal(dispatched, 1)
})

for (const [name, change, code] of [
  ['撤租约', (f: ReturnType<typeof fixture>) => f.state.grants.clear(), 'staleLease'],
  ['登录暂停', (f: ReturnType<typeof fixture>) => f.state.paused.add('lease'), 'signingIn'],
  [
    '用户停止',
    (f: ReturnType<typeof fixture>) => {
      f.state.stopped = true
    },
    'userStopped',
  ],
  [
    '文档代次变化',
    (f: ReturnType<typeof fixture>) => f.state.generations.set(1, 1),
    'staleDocument',
  ],
  ['同源新文档', (f: ReturnType<typeof fixture>) => f.navigate(), 'staleDocument'],
  ['来源变化', (f: ReturnType<typeof fixture>) => f.crossOrigin(), 'staleDocument'],
  ['视口变化', (f: ReturnType<typeof fixture>) => f.resize(), 'staleDocument'],
] as const) {
  test(`指针不绘制时仍拒绝${name}`, async () => {
    const f = fixture()
    f.poll(() => change(f))
    let dispatched = 0
    await assert.rejects(
      pointerCommand(
        f.state,
        f.grant,
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: 20, y: 20 },
        async () => {
          dispatched++
        },
      ),
      { code },
    )
    assert.equal(dispatched, 0)
  })
}
