import assert from 'node:assert/strict'
import test from 'node:test'
import { attach, type ExtensionState } from '../src/state.mjs'

test('已有调试器时不执行 attach，不影响对方连接', async () => {
  let attached = 0,
    detached = 0
  const state = {
    chrome: {
      debugger: {
        getTargets: async () => [{ tabId: 1, attached: true }],
        attach: async () => {
          attached++
        },
        detach: async () => {
          detached++
        },
      },
    },
  } as unknown as ExtensionState
  await assert.rejects(attach(state, 1), /already attached/)
  assert.equal(attached, 0)
  assert.equal(detached, 0)
})

test('单宿主 attach 后正常附着，不误判为其他宿主', async () => {
  let attached = false,
    detached = 0
  const state = {
    chrome: {
      debugger: {
        getTargets: async () => [{ tabId: 1, attached }],
        attach: async () => {
          attached = true
        },
        detach: async () => {
          detached++
        },
      },
    },
  } as unknown as ExtensionState
  await attach(state, 1)
  assert.equal(attached, true)
  assert.equal(detached, 0)
})

test('attach 后 target 丢失时收尾自身连接', async () => {
  let queried = 0,
    detached = 0
  const state = {
    chrome: {
      debugger: {
        getTargets: async () => (queried++ ? [] : [{ tabId: 1, attached: false }]),
        attach: async () => {},
        detach: async () => {
          detached++
        },
      },
    },
  } as unknown as ExtensionState
  await assert.rejects(attach(state, 1), /cannot attach/)
  assert.equal(detached, 1)
})
