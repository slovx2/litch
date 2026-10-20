// 内置浏览器里不碰 Electron 的几块：网址、审批记录、按键、快照排版与差异、CDP 白名单。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type AxNode, capLines, diffLines, formatAxTree, newRefBook } from '../ax.mjs'
import { isAllowedCdp } from '../cdp-allow.mjs'
import { parseKey } from '../keys.mjs'
import { createSiteBook, sessionKey } from '../sites.mjs'
import {
  blockedHostOf,
  hostMatches,
  isLocalHost,
  isOpenable,
  needsApproval,
  originOf,
  toAddress,
} from '../url.mjs'

test('本机地址的认法', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '[::1]',
  ]) {
    assert.equal(isLocalHost(host), true, host)
  }
  for (const host of ['example.com', '128.0.0.1', 'localhost.example.com', '10.0.0.1', '0.0.0.0']) {
    assert.equal(isLocalHost(host), false, host)
  }
  assert.equal(needsApproval('http://localhost:3000/'), false)
  assert.equal(needsApproval('http://[::1]:8080/x'), false)
  assert.equal(needsApproval('about:blank'), false)
  assert.equal(needsApproval('https://example.com/'), true)
  assert.equal(originOf('https://example.com:8443/a?b'), 'https://example.com:8443')
  assert.equal(originOf('file:///etc/hosts'), null)
})

test('地址栏里打的字', () => {
  assert.equal(toAddress('localhost:3000', false), 'http://localhost:3000/')
  assert.equal(toAddress('127.0.0.1:5173/app', false), 'http://127.0.0.1:5173/app')
  assert.equal(toAddress('example.com', false), 'https://example.com/')
  assert.equal(toAddress('https://example.com/x', false), 'https://example.com/x')
  assert.equal(toAddress('hello world', false), null)
  assert.match(
    toAddress('hello world', true) ?? '',
    /^https:\/\/duckduckgo\.com\/\?q=hello%20world$/,
  )
  assert.equal(isOpenable('file:///etc/hosts'), false)
  assert.equal(isOpenable('app://ui/index.html'), false)
  assert.equal(isOpenable('javascript:alert(1)'), false)
  assert.equal(isOpenable('about:blank'), true)
})

test('审批记录：这一次到回合结束、本会话、一直允许存盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-sites-'))
  try {
    const file = join(dir, 'browser', 'sites.json')
    const book = createSiteBook(file)
    const a = sessionKey('local', 'a')
    const b = sessionKey('local', 'b')
    assert.equal(book.verdict(a, 't1', 'https://x.test'), undefined)
    book.allowOnce(a, 't1', 'https://x.test')
    assert.equal(book.verdict(a, 't1', 'https://x.test'), 'allow')
    assert.equal(book.verdict(a, 't2', 'https://x.test'), undefined)
    book.decline(a, 't1', 'https://y.test')
    assert.equal(book.verdict(a, 't1', 'https://y.test'), 'decline')
    book.turnEnded(a, 't1')
    assert.equal(book.verdict(a, 't1', 'https://x.test'), undefined)
    assert.equal(book.verdict(a, 't1', 'https://y.test'), undefined)
    book.allowSession(a, 'https://s.test')
    assert.equal(book.verdict(a, 't9', 'https://s.test'), 'allow')
    assert.equal(book.verdict(b, 't9', 'https://s.test'), undefined)
    book.allowAlways('https://z.test')
    assert.equal(book.verdict(b, 't1', 'https://z.test'), 'allow')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { sites: Array<{ origin: string }> }
    assert.deepEqual(
      saved.sites.map((one) => one.origin),
      ['https://z.test'],
    )
    // 重新读出来还在
    assert.equal(createSiteBook(file).verdict(b, 'x', 'https://z.test'), 'allow')
    assert.equal(book.forget('https://nope.test'), 0)
    assert.equal(book.forget('https://z.test'), 1)
    assert.equal(createSiteBook(file).saved().length, 0)
    book.allowAlways('https://p.test')
    book.allowAlways('https://q.test')
    assert.equal(book.forget(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('按键', () => {
  const enter = parseKey('Enter')
  assert.equal(enter?.down.type, 'keyDown')
  assert.equal(enter?.down.text, '\r')
  const selectAll = parseKey('Meta+A')
  assert.equal(selectAll?.down.type, 'rawKeyDown')
  assert.equal(selectAll?.down.modifiers, 4)
  assert.deepEqual(selectAll?.down.commands, ['selectAll'])
  const ctrl = parseKey('Control+Shift+K')
  assert.equal(ctrl?.down.modifiers, 2 | 8)
  assert.equal(ctrl?.down.text, undefined)
  assert.equal(parseKey('Shift+a')?.down.text, 'A')
  assert.equal(parseKey('F5')?.down.windowsVirtualKeyCode, 116)
  assert.equal(parseKey('Hyper+A'), null)
  assert.equal(parseKey('NoSuchKey'), null)
})

const node = (nodeId: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
})

test('快照：缩进、编号、略过的节点、编号稳定', () => {
  const nodes: AxNode[] = [
    node('1', 'RootWebArea', 'Page', { childIds: ['2', '5'] }),
    node('2', 'generic', '', { parentId: '1', childIds: ['3', '4'] }),
    node('3', 'heading', 'Title', {
      parentId: '2',
      properties: [{ name: 'level', value: { value: 1 } }],
    }),
    node('4', 'button', 'Go', {
      parentId: '2',
      backendDOMNodeId: 40,
      childIds: ['6'],
      properties: [{ name: 'disabled', value: { value: true } }],
    }),
    node('6', 'StaticText', 'Go', { parentId: '4' }),
    node('5', 'textbox', 'Name', { parentId: '1', backendDOMNodeId: 50, value: { value: 'Ada' } }),
  ]
  const book = newRefBook()
  const lines = formatAxTree(nodes, book)
  assert.deepEqual(lines, [
    '- heading "Title" level=1',
    '- button "Go" disabled [ref=e1]',
    '- textbox "Name" value="Ada" [ref=e2]',
  ])
  assert.equal(book.byRef.get('e2'), 50)
  // 再排一次编号不变
  assert.deepEqual(formatAxTree(nodes, book), lines)
})

test('快照差异和上限', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c', 'd']), ['- b', '+ d'])
  assert.deepEqual(diffLines(['a'], ['a']), [])
  const many = Array.from({ length: 3000 }, (_x, i) => `- line ${i}`)
  const capped = capLines(many)
  assert.equal(capped.cut, true)
  assert.equal(capped.lines.length, 1500)
  assert.equal(diffLines(many, many.slice(1).concat(['x'])), null)
})

test('CDP 白名单', () => {
  for (const method of [
    'Page.captureScreenshot',
    'Accessibility.getFullAXTree',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
    'DOM.setFileInputFiles',
    'Runtime.evaluate',
  ]) {
    assert.equal(isAllowedCdp(method), true, method)
  }
  for (const method of [
    'Input.dispatchTouchEvent',
    'Input.dispatchDragEvent',
    'Input.synthesizePinchGesture',
    'Target.createTarget',
    'Target.attachToTarget',
    'Network.getCookies',
    'Network.getAllCookies',
    'Storage.getCookies',
    'Browser.close',
    'Fetch.enable',
    'Page.navigate',
    'Emulation.setGeolocationOverride',
    'Overlay.setInspectMode',
  ]) {
    assert.equal(isAllowedCdp(method), false, method)
  }
})

test('黑名单的写法和匹配', () => {
  assert.equal(blockedHostOf('example.com'), 'example.com')
  assert.equal(blockedHostOf(' https://WWW.Example.com:8443/a?b '), 'www.example.com')
  assert.equal(blockedHostOf('*.example.com'), 'example.com')
  assert.equal(blockedHostOf('example.com.'), 'example.com')
  assert.equal(blockedHostOf(''), null)
  assert.equal(blockedHostOf('two words'), null)
  assert.equal(blockedHostOf('ftp://example.com'), null)
  assert.equal(hostMatches('example.com', 'example.com'), true)
  assert.equal(hostMatches('a.b.Example.com', 'example.com'), true)
  assert.equal(hostMatches('notexample.com', 'example.com'), false)
  assert.equal(hostMatches('example.com.cn', 'example.com'), false)
})

test('信任所有网站和黑名单存盘，关着时照常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-sites-'))
  try {
    const file = join(dir, 'browser', 'sites.json')
    const book = createSiteBook(file)
    const a = sessionKey('local', 'a')
    assert.deepEqual(book.policy(), { trustAll: false, blocked: [] })
    book.block('z.test')
    book.block('b.test')
    book.block('b.test')
    // 关着时黑名单不起作用，照常问
    assert.equal(book.verdict(a, 't1', 'https://b.test'), undefined)
    book.decline(a, 't1', 'https://x.test')
    book.setTrustAll(true)
    assert.equal(book.verdict(a, 't1', 'https://x.test'), 'allow')
    assert.equal(book.verdict(a, 't1', 'https://m.b.test:8443'), 'blocked')
    const again = createSiteBook(file)
    assert.deepEqual(again.policy(), { trustAll: true, blocked: ['b.test', 'z.test'] })
    assert.equal(again.unblock('nope.test'), 0)
    assert.equal(again.unblock('b.test'), 1)
    assert.equal(again.verdict(a, 't1', 'https://b.test'), 'allow')
    assert.equal(again.unblock(), 1)
    again.setTrustAll(false)
    assert.deepEqual(createSiteBook(file).policy(), { trustAll: false, blocked: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
