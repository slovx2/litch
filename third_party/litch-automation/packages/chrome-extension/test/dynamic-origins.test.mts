import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChromeGrant } from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { execute } from '../src/requests.mjs'
import { documentStamp, type ExtensionState } from '../src/state.mjs'

function fixture() {
  const origin = 'https://atlas.test'
  const other = 'https://editor.atlas.test'
  const grant: ChromeGrant = {
    leaseId: 'lease',
    tabId: 1,
    owner: { deviceId: 'd', threadId: 's', turnId: 't' },
    original: true,
    keep: true,
    origins: [origin],
    expiresAt: Date.now() + 15000,
  }
  let dynamic = false
  let dispatch = () => {}
  let commands = 0
  const state = {
    epoch: 'epoch',
    grants: new Map([['lease', grant]]),
    generations: new Map(),
    stopped: false,
    paused: new Set(),
    stoppedTurns: new Set(),
    presentation: { active: async () => {}, keep: async () => {} },
    chrome: {
      tabs: { get: async () => ({ url: origin + '/', status: 'complete' }) },
      webNavigation: {
        getAllFrames: async () => [
          { url: origin + '/', frameId: 0, documentId: 'main' },
          ...(dynamic ? [{ url: other + '/', frameId: 1, documentId: 'editor' }] : []),
        ],
      },
      debugger: {
        sendCommand: async (_target: unknown, method: string) => {
          commands++
          dispatch()
          return method === 'Page.getFrameTree' ? { value: 'UNAPPROVED_CONTENT' } : {}
        },
      },
    },
  } as unknown as ExtensionState
  const call = (op: 'command' | 'authorize', args: Record<string, unknown>) =>
    execute(state, { kind: 'request', id: 'call', epoch: 'epoch', leaseId: 'lease', op, args })
  return {
    state,
    grant,
    other,
    call,
    dynamic: () => {
      dynamic = true
    },
    dispatch: (next: () => void) => {
      dispatch = next
    },
    commands: () => commands,
  }
}

test('动态来源必须先登记才允许观察；扩展不自行扩大 grant', async () => {
  const f = fixture()
  f.dynamic()
  await assert.rejects(documentStamp(f.state, f.grant), { code: 'staleDocument' })
  await assert.rejects(f.call('command', { method: 'Page.getFrameTree' }), {
    code: 'staleDocument',
  })
  assert.equal(f.commands(), 0)
  assert.deepEqual(f.grant.origins, ['https://atlas.test'])
  await f.call('authorize', { origins: [...f.grant.origins, f.other] })
  assert.ok(await documentStamp(f.state, f.grant))
})

test('读操作中途出现未授权 iframe 时丢弃结果，不夹带新页面内容', async () => {
  const f = fixture()
  f.dispatch(f.dynamic)
  await assert.rejects(f.call('command', { method: 'Page.getFrameTree' }), (error: any) => {
    assert.equal(error.code, 'staleDocument')
    assert.doesNotMatch(error.message, /UNAPPROVED_CONTENT/)
    assert.match(error.message, /snapshot/)
    return true
  })
  assert.equal(f.commands(), 1)
})

test('输入后出现新 iframe 只返回派发回执和标签元数据，不泄漏内容或扩大许可', async () => {
  const f = fixture()
  f.dispatch(f.dynamic)
  const result = (await f.call('command', {
    method: 'Page.handleJavaScriptDialog',
    params: { accept: true },
    inputReceipt: true,
  })) as { inputReceipt: boolean; documentChanged: boolean; value: unknown }
  assert.equal(result.inputReceipt, true)
  assert.equal(result.documentChanged, true)
  assert.doesNotMatch(JSON.stringify(result), /UNAPPROVED_CONTENT/)
  assert.deepEqual(f.grant.origins, ['https://atlas.test'])
  assert.equal(f.commands(), 1)
})
