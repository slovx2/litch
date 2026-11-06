import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChromeBridge } from '../../chrome-browser/bridge.mjs'
import { BrowserTargets } from '../../chrome-browser/browser-targets.mjs'
import { ChromeExecutor } from '../../chrome-browser/executor.mjs'
import type {
  ClientToolAnswer,
  ClientToolContext,
  ClientToolInvocation,
} from '../../client-tools/types.mjs'
import { createSiteBook } from '../sites.mjs'

const invocation = {
  device: { id: 'local', name: 'test', kind: 'local', target: null },
  threadId: 'thread',
  turnId: 'turn',
  callId: 'call',
  id: 'id',
  namespace: 'litch_browser',
  tool: 'claim',
  arguments: {},
  harness: null,
  cwd: null,
} satisfies ClientToolInvocation

function fixture(file: string | null = null) {
  let epoch = 'first'
  let event: (id: string, event: { kind: 'disconnected' }) => void = () => {}
  const bridge = {
    onEvent: (handler: typeof event) => {
      event = handler
      return () => {}
    },
    instances: () => [{ id: 'instance', epoch, name: 'Chrome' }],
    call: async (_instance: string, request: { op: string; args: Record<string, unknown> }) => {
      const tab = {
        id: 1,
        title: 'User page',
        url: 'https://example.com',
        generation: 1,
        origins: ['https://example.com'],
      }
      if (request.op === 'list') return [tab]
      return { tab }
    },
  } as unknown as ChromeBridge
  const sites = createSiteBook(file)
  const executor = new ChromeExecutor({ bridge, sites, allowed: () => true })
  const asks: string[] = []
  let answer: ClientToolAnswer = 'always'
  const context: ClientToolContext = {
    signal: new AbortController().signal,
    ask: async (ask) => {
      asks.push(ask.kind)
      return ask.kind === 'chromeTab' ? 'once' : answer
    },
  }
  return {
    executor,
    sites,
    asks,
    context,
    answer: (next: ClientToolAnswer) => {
      answer = next
    },
    reconnect: () => {
      epoch = 'second'
      event('instance', { kind: 'disconnected' })
    },
  }
}

test('Chrome 默认策略、信任所有网站和子域黑名单复用 SiteBook', async () => {
  const f = fixture()
  try {
    assert.deepEqual(f.sites.policy(), { trustAll: false, blocked: [] })
    f.sites.setTrustAll(true)
    await f.executor.approve(invocation, f.context, [
      'http://localhost:1234',
      'https://example.com',
    ])
    assert.equal(f.asks.length, 0)
    f.sites.allowAlways('https://private.example.com')
    f.sites.block('example.com')
    await assert.rejects(
      f.executor.approve(invocation, f.context, ['https://private.example.com']),
      /blocked/,
    )
    assert.equal(f.asks.length, 0)
    f.sites.setTrustAll(false)
    await f.executor.approve(invocation, f.context, ['https://private.example.com'])
  } finally {
    f.executor.dispose()
  }
})

test('Chrome 一直允许跨回合、连接代次和桌面重启保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-chrome-sites-'))
  const file = join(root, 'sites.json')
  const f = fixture(file)
  try {
    await f.executor.approve(invocation, f.context, ['https://example.com'])
    assert.deepEqual(f.asks, ['site'])
    f.executor.turnEnded({ deviceId: 'local', threadId: 'thread', turnId: 'turn' })
    f.reconnect()
    await f.executor.approve({ ...invocation, turnId: 'next' }, f.context, ['https://example.com'])
    assert.deepEqual(f.asks, ['site'])
    const restarted = fixture(file)
    try {
      await restarted.executor.approve({ ...invocation, threadId: 'other' }, restarted.context, [
        'https://example.com',
      ])
      assert.deepEqual(restarted.asks, [])
    } finally {
      restarted.executor.dispose()
    }
  } finally {
    f.executor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Chrome 本回合清理、本会话跨回合；拒绝不反复弹卡', async () => {
  const f = fixture()
  try {
    f.answer('once')
    await f.executor.approve(invocation, f.context, ['https://once.test'])
    f.answer('session')
    await f.executor.approve(invocation, f.context, ['https://session.test'])
    f.answer('decline')
    for (let i = 0; i < 2; i++)
      await assert.rejects(f.executor.approve(invocation, f.context, ['https://denied.test']))
    assert.equal(f.asks.length, 3)
    f.executor.turnEnded({ deviceId: 'local', threadId: 'thread', turnId: 'turn' })
    f.answer('once')
    for (const origin of ['https://once.test', 'https://session.test', 'https://denied.test'])
      await f.executor.approve({ ...invocation, turnId: 'next' }, f.context, [origin])
    assert.equal(f.asks.length, 5)
  } finally {
    f.executor.dispose()
  }
})

test('Chrome 信任所有网站不弹实例和标签卡；重连不恢复租约', async () => {
  const f = fixture()
  try {
    f.sites.setTrustAll(true)
    for (let i = 0; i < 2; i++) {
      const listed = await f.executor.call(
        {
          ...invocation,
          callId: `list${i}`,
          tool: 'tabs',
          arguments: { action: 'list', targetId: 'chrome:instance' },
        },
        f.context,
      )
      const content = listed.contentItems[0]
      assert.ok(content)
      assert.equal(content.type, 'inputText')
      if (content.type !== 'inputText') throw Error('Expected tab listing')
      const token = JSON.parse(content.text).tabs[0].claimToken
      const claimed = await f.executor.call(
        { ...invocation, callId: `claim${i}`, arguments: { claimToken: token } },
        f.context,
      )
      assert.equal(claimed.success, true)
      f.reconnect()
    }
    assert.equal(f.asks.filter((kind) => kind === 'chromeTab').length, 0)
    assert.equal(f.asks.filter((kind) => kind === 'chromeInstance').length, 0)
    assert.equal(f.asks.filter((kind) => kind === 'site').length, 0)
  } finally {
    f.executor.dispose()
  }
})

test('Chrome 设置入口写入独立持久策略，重启读取并可撤销', async () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-cs-'))
  writeFileSync(join(root, 'identity.json'), JSON.stringify({ id: 'fixture', version: '0.33.0' }))
  const options = {
    root: join(root, 'chrome'),
    assets: root,
    nativeBinary: '',
    openInChrome: async () => {
      throw Error('不得打开用户浏览器')
    },
    openDirectory: async () => {
      throw Error('不得打开系统目录')
    },
  }
  let targets = new BrowserTargets(options)
  try {
    const initial = await targets.settings({ kind: 'chrome.status' })
    assert.equal(initial.lastError, null)
    assert.deepEqual(initial.sitePolicy, { trustAll: false, blocked: [] })
    assert.deepEqual(initial.savedSites, [])
    const routed = targets.dispatch({
      namespace: 'litch_browser',
      call: async () => assert.fail('不得转到内置浏览器'),
      turnEnded: () => {},
      currentTab: () => null,
    })
    const context: ClientToolContext = {
      signal: new AbortController().signal,
      ask: async () => assert.fail('总开关不弹卡'),
    }
    const remote: ClientToolInvocation = {
      ...invocation,
      tool: 'targets',
      device: { id: 'remote', name: 'Remote test', kind: 'ssh', target: 'fixture' },
    }
    assert.equal((await routed.call(remote, context)).success, false)
    await targets.settings({ kind: 'chrome.enable', enabled: true })
    const blocked = await routed.call(remote, context)
    assert.equal(blocked.success, false)
    assert.match(JSON.stringify(blocked), /Remote test.*Settings → Chrome/)
    await targets.settings({ kind: 'chrome.device', deviceId: 'remote', enabled: true })
    assert.equal((await routed.call(remote, context)).success, true)
    await targets.settings({ kind: 'chrome.trust', on: true })
    await targets.settings({ kind: 'chrome.block', site: 'https://Blocked.Example/path' })
    await assert.rejects(targets.settings({ kind: 'chrome.block', site: 'bad host' }))
    const file = join(root, 'chrome', 'sites.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.blocked, ['blocked.example'])
    assert.equal(saved.trustAll, true)
    await targets.dispose()
    targets = new BrowserTargets(options)
    assert.deepEqual((await targets.settings({ kind: 'chrome.status' })).sitePolicy, {
      trustAll: true,
      blocked: ['blocked.example'],
    })
    await targets.settings({ kind: 'chrome.unblock', host: 'blocked.example' })
    assert.deepEqual((await targets.settings({ kind: 'chrome.trust', on: false })).sitePolicy, {
      trustAll: false,
      blocked: [],
    })
  } finally {
    await targets.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
