import assert from 'node:assert/strict'
import test from 'node:test'
import { attachFailure, chromeText, restrictedPage, safeAttachError } from '../src/attach-error.mjs'
import { execute } from '../src/requests.mjs'
import { attach, ChromeFault, type ExtensionState, inspectOrigins } from '../src/state.mjs'

const english = chromeText({})
const chinese = chromeText({ i18n: { getUILanguage: () => 'zh-CN' } })

for (const [url, label] of [
  ['chrome://extensions/', 'internal Chrome'],
  ['chrome-untrusted://new-tab-page/', 'internal Chrome'],
  ['devtools://devtools/', 'internal Chrome'],
  ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/options.html', 'extension page'],
  ['chrome-error://chromewebdata/', 'error page'],
  ['about:neterror', 'error page'],
  ['https://chromewebstore.google.com/detail/id', 'Chrome Web Store'],
  ['https://chrome.google.com/webstore/detail/id', 'Chrome Web Store'],
] as const) {
  test(`受限页面 ${url} 在来源与 attach 前拒绝`, async () => {
    const state = {
      chrome: { tabs: { get: async () => ({ url }) } },
      generations: new Map(),
    } as unknown as ExtensionState
    assert.match(restrictedPage(url, english) ?? '', new RegExp(label))
    assert.match(restrictedPage(url, chinese) ?? '', /请新开普通 HTTP\(S\)/)
    for (const run of [() => inspectOrigins(state, 1), () => attach(state, 1)])
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof ChromeFault)
        assert.equal(error.code, 'targetUnavailable')
        assert.match(error.message, /Open a new regular HTTP\(S\) tab/)
        assert.doesNotMatch(error.message, /Close.*DevTools/)
        return true
      })
  })
}

test('商店主机和旧路径匹配有边界，普通页面仍可接管', () => {
  for (const url of [
    'about:blank',
    'https://example.test/',
    'https://chrome.google.com/webstore-other',
    'https://chrome.google.com/',
    'https://chromewebstore.google.com.evil.test/',
    'https://example.test/?next=https://chromewebstore.google.com',
  ])
    assert.equal(restrictedPage(url, english), null)
})

for (const [raw, code, hint] of [
  [
    'Cannot access a chrome-extension:// URL of different extension',
    'targetUnavailable',
    'denied debugging',
  ],
  [
    'Cannot access contents of url "https://example.test/".',
    'targetUnavailable',
    'denied debugging',
  ],
  ['Another debugger is already attached to the tab with id: 1.', 'busy', 'existing debugger'],
  ['DevTools is already open', 'busy', 'DevTools connection'],
  ['Host access is restricted by policy.', 'targetUnavailable', 'management policy'],
  [
    'This page cannot be scripted due to an ExtensionsSettings policy.',
    'targetUnavailable',
    'management policy',
  ],
  ['No tab with given id 1.', 'staleDocument', 'closed or changed'],
  ['Unexpected internal failure', 'targetUnavailable', 'Follow the original error'],
  [
    'Cannot access contents of url "https://fixture-user:fixture-pass@example.test/private?token=fixture-query#fixture-fragment".',
    'targetUnavailable',
    'denied debugging',
  ],
  [
    'Host access is restricted by policy. Authorization: Bearer fixture-bearer',
    'targetUnavailable',
    'management policy',
  ],
] as const) {
  test(`attach 原始错误保留并分类：${raw}`, async (t) => {
    const log = t.mock.method(console, 'error', () => {})
    const original = new Error(raw)
    let detached = false
    const state = {
      chrome: {
        tabs: { get: async () => ({ url: 'https://example.test/' }) },
        debugger: {
          getTargets: async () => [{ tabId: 1, attached: false }],
          attach: async () => {
            throw original
          },
          detach: async () => {
            detached = true
          },
        },
      },
      generations: new Map(),
    } as unknown as ExtensionState
    await assert.rejects(attach(state, 1), (error: unknown) => {
      assert.ok(error instanceof ChromeFault)
      assert.equal(error.code, code)
      assert.equal(error.cause, original)
      assert.ok(error.message.includes(safeAttachError(raw)))
      assert.ok(error.message.includes(hint))
      assert.doesNotMatch(error.message, /fixture-(?:user|pass|query|fragment|bearer)/)
      return true
    })
    assert.equal(detached, false)
    assert.deepEqual(log.mock.calls[0]?.arguments, [
      'Chrome debugger attach failed',
      { tabId: 1, error: safeAttachError(raw) },
    ])
    assert.ok(
      attachFailure(raw, '', chinese).message.includes(`Chrome 原始错误： ${safeAttachError(raw)}`),
    )
  })
}

test('诊断脱敏去掉 URL、认证头和显式秘密，保留普通错误且限制日志长度', () => {
  assert.equal(
    safeAttachError('Cannot access contents of url "https://user:pass@example.test/?token=value".'),
    'Cannot access contents of url "[redacted URL]".',
  )
  for (const header of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie'])
    assert.equal(safeAttachError(`${header}: session=fixture-secret`), `${header}: [redacted]`)
  for (const key of [
    'token',
    'access_token',
    'refreshToken',
    'password',
    'apiKey',
    'client_secret',
  ])
    assert.equal(safeAttachError(`${key}="fixture secret"`), `${key}=[redacted]`)
  assert.equal(safeAttachError('Unexpected internal failure'), 'Unexpected internal failure')
  assert.equal(safeAttachError('x'.repeat(3000)).length, 2048)
})

test('标签列表保留受限当前页及原因，读取不到正文或框架', async () => {
  const url = 'chrome://settings/'
  const state = {
    epoch: 'epoch',
    paused: new Set(),
    grants: new Map(),
    generations: new Map(),
    chrome: {
      tabs: {
        query: async () => [{ id: 1, url, active: true, windowId: 2 }],
        get: async () => ({ url }),
      },
      windows: { getLastFocused: async () => ({ id: 2 }) },
      debugger: { getTargets: async () => [{ tabId: 1, id: 'a'.repeat(32) }] },
    },
  } as unknown as ExtensionState
  const result = (await execute(state, {
    kind: 'request',
    id: 'list',
    epoch: 'epoch',
    op: 'list',
    args: {},
  })) as any[]
  assert.equal(result.length, 1)
  assert.match(result[0].unavailableReason, /internal Chrome/)
  assert.equal(result[0].active, true)
  assert.deepEqual(result[0].origins, [])
})
