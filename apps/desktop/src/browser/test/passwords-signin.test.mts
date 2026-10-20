// 交给人登录（request_sign_in）：登记（signin.mts）和执行器那一头（executor.mts、tools-signin.mts）。
// 量的是：卡片只给界面、同一个标签一次一张；交出去之后代理对这个标签的调用（快照、截图、执行脚本、点、输入、
// 导航、关掉）一律被拒；执行过脚本的标记交给交接的那一层；等人的时候停表；结果只说交还还是取消、不带输入。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolCallResponse } from '../../../../../packages/protocol/src/client-tools.mjs'
import type { ClientToolInvocation } from '../../client-tools/types.mjs'
import {
  type BrowserHandover,
  createBrowserExecutor,
  SIGNING_IN,
  type SignInOutcome,
} from '../executor.mjs'
import type { BrowserHost, BrowserPage, DialogInfo, TabKind, TabOwner } from '../model.mjs'
import { createSignIns } from '../passwords/signin.mjs'
import { createSiteBook } from '../sites.mjs'

function fakeHost(): BrowserHost {
  const pages = new Map<string, BrowserPage>()
  let seq = 0
  return {
    pages: () => [...pages.values()],
    page: (id) => pages.get(id),
    open(owner: TabOwner, kind: TabKind) {
      const id = `t${++seq}`
      let url = 'about:blank'
      const page: BrowserPage = {
        id,
        info: () => ({
          id,
          owner,
          kind,
          url,
          title: 'Sign in',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          agentActive: false,
          keep: false,
        }),
        async load(next) {
          url = next
          return { ok: true }
        },
        history: async () => ({ ok: true }),
        waitForLoad: async () => true,
        async cdp<T>(method: string): Promise<T> {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f', url } } } as T
          if (method === 'Accessibility.getFullAXTree') return { nodes: [] } as T
          if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 1 } } as T
          if (method === 'Page.captureScreenshot') return { data: 'AAAA' } as T
          return {} as T
        },
        consoleEntries: () => [],
        clearConsole() {},
        dialog: (): DialogInfo | null => null,
        dialogOpened: () => new Promise<DialogInfo>(() => {}),
        takeNotices: () => [],
        setAgentActive() {},
        pointAt: async () => {},
      }
      pages.set(id, page)
      return page
    },
    close: (id) => void pages.delete(id),
    setKeep() {},
    release() {},
    show() {},
    setNavigationGate() {},
  }
}

/** 假的交接：登记一张卡片，等测试里答 */
function fakeHandover() {
  const signIns = createSignIns()
  const frozen = new Set<string>()
  const scripted: string[] = []
  const asked: Array<{ site: string; reason: string }> = []
  const handover: BrowserHandover = {
    active: (tabId) => frozen.has(tabId),
    markScripted: (tabId) => void scripted.push(tabId),
    async request(page, ask, signal): Promise<SignInOutcome> {
      asked.push(ask)
      const begun = signIns.begin({ owner: page.info().owner, tabId: page.id, ...ask })
      if (!begun) return 'aborted'
      frozen.add(page.id)
      try {
        return await Promise.race([
          begun.answered,
          new Promise<SignInOutcome>((resolve) =>
            signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
          ),
        ])
      } finally {
        signIns.end(begun.id)
        frozen.delete(page.id)
      }
    },
  }
  return { handover, signIns, scripted, asked }
}

function setup() {
  const host = fakeHost()
  const { handover, signIns, scripted, asked } = fakeHandover()
  const executor = createBrowserExecutor({ host, sites: createSiteBook(null), handover })
  let holds = 0
  let released = 0
  let seq = 0
  const run = (
    tool: string,
    args: unknown = {},
    signal = new AbortController().signal,
  ): Promise<ClientToolCallResponse> => {
    const invocation: ClientToolInvocation = {
      id: `i${++seq}`,
      threadId: 'a',
      turnId: 'turn-1',
      callId: `c${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: { id: 'local', name: '本机', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
    }
    return executor.call(invocation, {
      signal,
      ask: async () => null,
      hold() {
        holds++
        return () => void released++
      },
    })
  }
  return { run, signIns, scripted, asked, holds: () => holds, released: () => released }
}

const textOf = (reply: ClientToolCallResponse) =>
  reply.contentItems.map((one) => (one.type === 'inputText' ? one.text : '')).join('\n')
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('交给人：卡片只给界面，代理对这个标签的调用一律被拒；交还之后只说交还了，不带输入', async () => {
  const { run, signIns, scripted, asked, holds, released } = setup()
  await run('navigate', { url: 'http://localhost:3000/login' })
  // 交之前执行过脚本：标记交给交接的那一层（它在交出去之前重新载入）
  await run('evaluate', { expression: '1' })
  assert.deepEqual(scripted, ['t1'])

  const pending = run('request_sign_in', { site: 'Demo', reason: 'To open your dashboard.' })
  await settle()
  const [card] = signIns.list()
  assert.equal(card?.site, 'Demo')
  assert.equal(card?.reason, 'To open your dashboard.')
  assert.equal(card?.tabId, 't1')
  assert.deepEqual(asked, [{ site: 'Demo', reason: 'To open your dashboard.' }])
  assert.equal(holds(), 1)

  for (const [tool, args] of [
    ['snapshot', {}],
    ['screenshot', {}],
    ['evaluate', { expression: 'document.title' }],
    ['console', {}],
    ['click', { ref: 'e1' }],
    ['type', { text: 'x' }],
    ['press', { key: 'Enter' }],
    ['navigate', { url: 'http://localhost:3000/other' }],
    ['tabs', { action: 'close', tabId: 't1' }],
    ['request_sign_in', { reason: 'again' }],
  ] as const) {
    const reply = await run(tool, args)
    assert.equal(reply.success, false, tool)
    assert.ok(textOf(reply).includes(SIGNING_IN), `${tool}: ${textOf(reply)}`)
  }
  // 开新标签不碰这个标签，照常
  assert.equal((await run('tabs', { action: 'list' })).success, true)

  assert.equal(signIns.answer(card?.id ?? '', 'done'), true)
  const reply = await pending
  assert.equal(reply.success, true, textOf(reply))
  assert.match(textOf(reply), /finished signing in to Demo/)
  assert.equal(released(), 1)
  // 交还之后又能用了
  const after = await run('snapshot', { tabId: 't1' })
  assert.equal(after.success, true, textOf(after))
  assert.deepEqual(signIns.list(), [])
})

test('人点取消：告诉代理别换别的办法登录；回合打断：卡片撤掉、表放开', async () => {
  const { run, signIns, released } = setup()
  await run('navigate', { url: 'http://localhost:3000/login' })
  const first = run('request_sign_in', { reason: 'Need access.' })
  await settle()
  signIns.answer(signIns.list()[0]?.id ?? '', 'cancel')
  const cancelled = await first
  assert.match(textOf(cancelled), /cancelled signing in to localhost:3000/)
  assert.match(textOf(cancelled), /Do not try to sign in another way/)

  const controller = new AbortController()
  const second = run('request_sign_in', { reason: 'Need access.' }, controller.signal)
  await settle()
  assert.equal(signIns.list().length, 1)
  controller.abort()
  const aborted = await second
  assert.equal(aborted.success, false)
  await settle()
  assert.deepEqual(signIns.list(), [])
  assert.equal(released(), 2)
  const after = await run('snapshot')
  assert.equal(after.success, true, textOf(after))
})

test('登记：同一个标签一次一张，答过的、撤掉的再答不算', () => {
  const signIns = createSignIns({ now: () => 5 })
  const pushed: unknown[] = []
  signIns.onChange((list) => pushed.push(list))
  const owner = { deviceId: 'local', threadId: 'a' }
  const one = signIns.begin({ owner, tabId: 't1', site: 's', reason: 'r' })
  assert.ok(one)
  assert.equal(signIns.begin({ owner, tabId: 't1', site: 's', reason: 'r' }), null)
  assert.equal(signIns.active('t1'), true)
  assert.deepEqual(signIns.list()[0], {
    id: one.id,
    deviceId: 'local',
    threadId: 'a',
    tabId: 't1',
    site: 's',
    reason: 'r',
    at: 5,
  })
  signIns.end(one.id)
  assert.equal(signIns.answer(one.id, 'done'), false)
  assert.equal(signIns.active('t1'), false)
  assert.equal(pushed.length, 2)
})
