import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loginTailscale } from '../src/platform/tailscale-login.ts'

const signedOut = { state: 'needsLogin', authURL: '' }
const pending = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('登录 URL 迟到时自动打开一次，已连接和待批准不打开浏览器', async () => {
  for (const state of ['needsLogin', 'connected', 'needsApproval']) {
    const opened = []
    const accepted = []
    let calls = 0
    await loginTailscale('', {
      signal: new AbortController().signal,
      intervalMs: 1,
      client: {
        login: async () => signedOut,
        status: async () =>
          ++calls < 2 ? signedOut : { state, authURL: 'https://login.example/a' },
      },
      accept: (status) => accepted.push(status.state),
      open: async (url) => opened.push(url),
    })
    assert.deepEqual(opened, state === 'needsLogin' ? ['https://login.example/a'] : [])
    assert.equal(accepted.at(-1), state)
  }
})

test('原生登录阻塞超过期限后允许重试，迟到 URL 不再弹出', async () => {
  const native = pending()
  const opened = []
  await assert.rejects(
    loginTailscale('', {
      signal: new AbortController().signal,
      timeoutMs: 10,
      client: { login: () => native.promise, status: async () => signedOut },
      accept: () => assert.fail('迟到状态不应覆盖界面'),
      open: async (url) => opened.push(url),
    }),
    /tailscaleLoginTimeout/,
  )
  native.resolve({ ...signedOut, authURL: 'https://login.example/late' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(opened, [])
})

test('离开页面取消等待，重开时不会被旧登录请求打开浏览器', async () => {
  const controller = new AbortController()
  const native = pending()
  const operation = loginTailscale('', {
    signal: controller.signal,
    client: { login: () => native.promise, status: async () => signedOut },
    accept: () => assert.fail('已取消'),
    open: async () => assert.fail('已取消'),
  })
  controller.abort()
  await assert.rejects(operation, /tailscaleCancelled/)
  native.resolve({ ...signedOut, authURL: 'https://login.example/late' })
  await new Promise((resolve) => setImmediate(resolve))
})
