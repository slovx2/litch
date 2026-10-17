// 对话里的链接点了去哪（side/browser/link-logic.ts）：内置浏览器还是系统的浏览器、同一个网址切过去、设置怎么读。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。真点一下的那一半在
// apps/desktop/src/probe-browser-links.mts（npm run check:browser --prefix apps/desktop）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { readLinksPref, routeLink, sameUserTab } = await import('../src/side/browser/link-logic.ts')

const plain = { button: 0, metaKey: false, ctrlKey: false }
const owner = { deviceId: 'local', threadId: 's1' }
const base = { click: plain, mac: true, hasBrowser: true, enabled: true, owner }

test('默认：点链接在内置浏览器里开', () => {
  assert.equal(routeLink(base), 'browser')
  // 新建对话页上会话标识是空的，也算眼前的会话
  assert.equal(routeLink({ ...base, owner: { deviceId: 'local', threadId: '' } }), 'browser')
})

test('修饰键、中键：交给系统的浏览器', () => {
  assert.equal(routeLink({ ...base, click: { ...plain, metaKey: true } }), 'external')
  assert.equal(routeLink({ ...base, click: { ...plain, button: 1 } }), 'external')
  // macOS 上认 Cmd，Ctrl 点不算退路
  assert.equal(routeLink({ ...base, click: { ...plain, ctrlKey: true } }), 'browser')
  // 别的系统认 Ctrl，Meta（Windows 键）不算
  assert.equal(routeLink({ ...base, mac: false, click: { ...plain, ctrlKey: true } }), 'external')
  assert.equal(routeLink({ ...base, mac: false, click: { ...plain, metaKey: true } }), 'browser')
})

test('设置里关掉了：交给系统的浏览器', () => {
  assert.equal(routeLink({ ...base, enabled: false }), 'external')
})

test('普通浏览器里的预览（没有内置浏览器）：交给系统的浏览器', () => {
  assert.equal(routeLink({ ...base, hasBrowser: false }), 'external')
})

test('眼前没有会话（设置这类页面）：交给系统的浏览器', () => {
  assert.equal(routeLink({ ...base, owner: null }), 'external')
})

test('终端里的链接：终端和眼前的会话在同一台设备上才进内置浏览器', () => {
  assert.equal(routeLink({ ...base, device: 'local' }), 'browser')
  assert.equal(routeLink({ ...base, device: 'build' }), 'external')
})

const tab = (id, extra = {}) => ({
  id,
  owner,
  kind: 'user',
  url: 'about:blank',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentActive: false,
  keep: false,
  ...extra,
})

test('同一个网址的用户标签：切过去', () => {
  const tabs = [
    tab('t1', { url: 'https://example.com/a' }),
    tab('t2', { url: 'https://example.com/' }),
  ]
  assert.equal(sameUserTab(tabs, owner, 'https://example.com/a'), 't1')
  // 规范写法一样就算同一个：主机名大小写、没写的斜杠
  assert.equal(sameUserTab(tabs, owner, 'https://EXAMPLE.com'), 't2')
  assert.equal(sameUserTab(tabs, owner, 'https://example.com/b'), null)
})

test('代理开的、别的会话的标签：不算', () => {
  const tabs = [
    tab('t1', { url: 'https://example.com/a', kind: 'agent' }),
    tab('t2', { url: 'https://example.com/a', owner: { deviceId: 'local', threadId: 's2' } }),
    tab('t3', { url: 'https://example.com/a', owner: { deviceId: 'build', threadId: 's1' } }),
  ]
  assert.equal(sameUserTab(tabs, owner, 'https://example.com/a'), null)
})

test('设置：默认开，只有明说关了才关', () => {
  assert.equal(readLinksPref(null), true)
  assert.equal(readLinksPref('{"links":true}'), true)
  assert.equal(readLinksPref('{"links":false}'), false)
  assert.equal(readLinksPref('坏了'), true)
  assert.equal(readLinksPref('{"links":"no"}'), true)
})
