import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundTab } from '../../../../../packages/chrome-extension/src/background-tab.mjs'
import { execute } from '../../../../../packages/chrome-extension/src/requests.mjs'
import type { ExtensionState } from '../../../../../packages/chrome-extension/src/state.mjs'

test('新标签显式指定普通窗口并保持后台，不进入隐私窗口', async () => {
  const calls: unknown[] = []
  const chrome = {
    windows: { getAll: async () => [{ id: 1, incognito: true, focused: true }, { id: 2 }] },
    tabs: {
      create: async (args: unknown) => {
        calls.push(args)
        return { id: 3 }
      },
    },
  }
  assert.equal((await createBackgroundTab(chrome)).id, 3)
  assert.deepEqual(calls, [{ windowId: 2, url: 'about:blank', active: false }])
})

test('没有普通窗口时创建不获取焦点的窗口，不依赖浏览器默认行为', async () => {
  const calls: unknown[] = []
  const chrome = {
    windows: {
      getAll: async () => [],
      create: async (args: unknown) => {
        calls.push(args)
        return { tabs: [{ id: 4 }] }
      },
    },
  }
  assert.equal((await createBackgroundTab(chrome)).id, 4)
  assert.deepEqual(calls, [{ url: 'about:blank', type: 'normal', focused: false }])
})

test('登录等待只暂停并关闭焦点模拟，不调用标签或窗口激活', async () => {
  const commands: unknown[] = []
  const state = {
    epoch: 'epoch',
    stopped: false,
    paused: new Set<string>(),
    stoppedTurns: new Set<string>(),
    grants: new Map([
      [
        'lease',
        {
          leaseId: 'lease',
          tabId: 1,
          origins: ['https://fixture.test'],
          owner: { deviceId: 'local', threadId: 'thread', turnId: 'turn' },
          expiresAt: Date.now() + 15000,
        },
      ],
    ]),
    generations: new Map([[1, 1]]),
    console: new Map(),
    chrome: {
      tabs: {
        get: async () => ({ id: 1, url: 'https://fixture.test', status: 'complete' }),
        update: async () => {
          assert.fail('must not activate a tab')
        },
      },
      windows: {
        update: async () => {
          assert.fail('must not focus a window')
        },
      },
      webNavigation: {
        getAllFrames: async () => [
          { frameId: 0, documentId: 'document', url: 'https://fixture.test' },
        ],
      },
      debugger: {
        sendCommand: async (_target: unknown, method: string, params: unknown) => {
          commands.push([method, params])
        },
      },
    },
  } as unknown as ExtensionState
  await execute(state, {
    kind: 'request',
    id: 'freeze',
    epoch: 'epoch',
    op: 'freeze',
    leaseId: 'lease',
    generation: 1,
    args: {},
  })
  assert.equal(state.paused.has('lease'), true)
  assert.deepEqual(commands, [['Emulation.setFocusEmulationEnabled', { enabled: false }]])
})
