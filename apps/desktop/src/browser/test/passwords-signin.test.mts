// 交给人登录（request_sign_in）：登记（signin.mts）和执行器那一头（executor.mts、tools-signin.mts）。
// 量的是：卡片只给界面、同一个标签一次一张；交出去之后代理对这个标签的调用（快照、截图、执行脚本、点、输入、
// 导航、关掉）一律被拒；执行过脚本的标记交给交接的那一层；等人的时候停表；结果只说交还还是取消、不带输入。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import type { ClientToolCallResponse } from '../../../../../packages/protocol/src/client-tools.mjs'
import type { ClientToolInvocation } from '../../client-tools/types.mjs'
import {
  type BrowserHandover,
  createBrowserExecutor,
  SIGNING_IN,
  type SignInAsk,
  type SignInOutcome,
} from '../executor.mjs'
import type { BrowserHost, BrowserPage, DialogInfo, TabKind, TabOwner } from '../model.mjs'
import { type DomNode, hasClosedShadowFields } from '../passwords/dom-tree.mjs'
import { createSignIns } from '../passwords/signin.mjs'
import {
  handoverOf,
  isHandoverPopup,
  notePopup,
  registerAutofillTab,
  setHandedOver,
  takePopups,
} from '../passwords/tabs.mjs'
import { createSiteBook } from '../sites.mjs'
import { createTabLog, type TabLog } from '../tab-log.mjs'

/** quiet：这个标签正交给人登录（真的那一份是 passwords/tabs.mts 的 isHandedOver），控制台和提示照它不收 */
function fakeHost(
  quiet: (tabId: string) => boolean,
): BrowserHost & { logOf(tabId: string): TabLog } {
  const pages = new Map<string, BrowserPage>()
  const logs = new Map<string, TabLog>()
  let seq = 0
  return {
    logOf: (tabId) => {
      const log = logs.get(tabId)
      if (!log) throw new Error(`no tab ${tabId}`)
      return log
    },
    pages: () => [...pages.values()],
    page: (id) => pages.get(id),
    open(owner: TabOwner, kind: TabKind) {
      const id = `t${++seq}`
      let url = 'about:blank'
      const log = createTabLog(() => quiet(id))
      logs.set(id, log)
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
        consoleEntries: log.consoleEntries,
        clearConsole: log.clearConsole,
        dialog: (): DialogInfo | null => null,
        dialogOpened: () => new Promise<DialogInfo>(() => {}),
        takeNotices: log.takeNotices,
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
    hides: (tabId) => frozen.has(tabId),
    markScripted: (tabId) => void scripted.push(tabId),
    async request(page, ask, signal): Promise<SignInOutcome> {
      asked.push({ site: ask.site, reason: ask.reason })
      const begun = signIns.begin({
        owner: page.info().owner,
        tabId: page.id,
        origin: new URL(page.info().url).origin,
        site: ask.site,
        reason: ask.reason,
      })
      if (!begun) return 'aborted'
      frozen.add(page.id)
      try {
        return await Promise.race([
          begun.answered.then(
            (resolved): SignInOutcome => (resolved.kind === 'done' ? 'done' : 'cancel'),
          ),
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
  const { handover, signIns, scripted, asked } = fakeHandover()
  const host = fakeHost((tabId) => handover.active(tabId))
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
  return {
    run,
    signIns,
    scripted,
    asked,
    logOf: host.logOf,
    holds: () => holds,
    released: () => released,
  }
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
  // tabs list 里只给占位，不给地址和标题；带 tabId 的 show 也拒
  const listed = textOf(await run('tabs', { action: 'list' }))
  assert.match(listed, /"signingIn": true/)
  assert.equal(listed.includes('localhost:3000'), false)
  assert.equal(listed.includes('Sign in'), false)
  const shown = await run('show', { tabId: 't1' })
  assert.equal(shown.success, false)
  assert.ok(textOf(shown).includes(SIGNING_IN))

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
  assert.match(textOf(cancelled), /declined signing in to localhost:3000/)
  assert.match(textOf(cancelled), /Do not try another way/)

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

test('交给人期间网页打的日志、被拦的地址不收：交还后 console 读不到，结果的提示里也没有；交之前、交还之后的照常', async () => {
  const { run, signIns, logOf } = setup()
  await run('navigate', { url: 'http://localhost:3000/login' })
  const log = logOf('t1')
  const entry = (text: string) => ({ level: 'info' as const, text, source: '', at: Date.now() })
  log.console(entry('before-handover'))
  log.notice('Notice before handover.')

  const pending = run('request_sign_in', { site: 'Demo', reason: 'To open your dashboard.' })
  await settle()
  const [card] = signIns.list()
  // 人登录的时候网页把输入打进控制台、跳去的地址里带着输入、弹窗开去别处，都被拦下来记成提示
  log.console(entry('typed password hunter2-secret'))
  log.notice(
    'A redirect to https://evil.example/?p=hunter2-secret was blocked because that site is not approved yet.',
  )
  log.notice('The page opened https://sso.example/?u=ann-secret in a new tab t9.')
  assert.ok(card)
  signIns.answer(card.id, 'done')
  const reply = textOf(await pending)
  assert.match(reply, /finished signing in to Demo/)
  assert.equal(/secret/.test(reply), false, reply)

  const consoleText = textOf(await run('console', {}))
  assert.match(consoleText, /before-handover/)
  assert.equal(consoleText.includes('hunter2-secret'), false, consoleText)
  log.console(entry('after-handover'))
  log.notice('Notice after handover.')
  const snapshot = textOf(await run('snapshot'))
  assert.equal(/secret/.test(snapshot), false, snapshot)
  assert.match(snapshot, /Notice after handover/)
  assert.match(textOf(await run('console', {})), /after-handover/)
})

test('同一个标签前后脚两次请人登录：第二次直接回“已在等”，不动第一次的交接', async () => {
  const { run, signIns, asked } = setup()
  await run('navigate', { url: 'http://localhost:3000/login' })
  const first = run('request_sign_in', { reason: 'One.' })
  const second = run('request_sign_in', { reason: 'Two.' })
  const busy = textOf(await second)
  assert.match(busy, /already waiting for the user/)
  assert.equal(asked.length, 1)
  const [card] = signIns.list()
  assert.equal(signIns.list().length, 1)
  assert.equal(card?.state, 'waiting')
  assert.equal(card?.reason, 'One.')
  // 第一次的交接照常：人交还了才回
  assert.ok(card)
  signIns.answer(card.id, 'done')
  assert.match(textOf(await first), /finished signing in/)
})

test('登记：同一个标签一次一张在等；来源跟着导航换；答过的、撤掉的再答不算', () => {
  const signIns = createSignIns({ now: () => 5 })
  const pushed: unknown[] = []
  signIns.onChange((list) => pushed.push(list))
  const owner = { deviceId: 'local', threadId: 'a' }
  const input = { owner, tabId: 't1', origin: 'https://a.example', site: 's', reason: 'r' }
  const one = signIns.begin(input)
  assert.ok(one)
  assert.equal(signIns.begin(input), null)
  assert.deepEqual(signIns.list()[0], {
    id: one.id,
    deviceId: 'local',
    threadId: 'a',
    tabId: 't1',
    origin: 'https://a.example',
    site: 's',
    reason: 'r',
    state: 'waiting',
    stage: 'choose',
    accounts: [],
    fillBlocked: null,
    taskId: null,
    expiresAt: null,
    nonce: signIns.list()[0]?.nonce,
    at: 5,
  })
  signIns.setOrigin(one.id, 'https://sso.example')
  assert.equal(signIns.list()[0]?.origin, 'https://sso.example')
  // 在等的卡片不认“知道了”
  assert.equal(signIns.answer(one.id, 'dismiss'), false)
  signIns.end(one.id)
  assert.equal(signIns.answer(one.id, 'done'), false)
  assert.deepEqual(signIns.list(), [])
  assert.equal(pushed.length, 3)
})

test('代理不等了：卡片变成“代理已收回”，留着等人点知道了，到点也撤；标签没了一起撤', async () => {
  const timers: Array<() => void> = []
  const signIns = createSignIns({ schedule: (run) => void timers.push(run) })
  const owner = { deviceId: 'local', threadId: 'a' }
  const input = { owner, tabId: 't1', origin: 'https://a.example', site: 's', reason: 'r' }
  const one = signIns.begin(input)
  assert.ok(one)
  let settled = false
  void one.answered.then(() => {
    settled = true
  })
  signIns.withdraw(one.id)
  assert.equal(signIns.list()[0]?.state, 'withdrawn')
  // 收回了的卡片点“完成”“取消”不算，代理那头也不会收到
  assert.equal(signIns.answer(one.id, 'done'), false)
  assert.equal(signIns.answer(one.id, 'dismiss'), true)
  await settle()
  assert.equal(settled, false)
  assert.deepEqual(signIns.list(), [])

  const two = signIns.begin(input)
  assert.ok(two)
  signIns.withdraw(two.id)
  timers.at(-1)?.()
  assert.deepEqual(signIns.list(), [])

  const three = signIns.begin(input)
  assert.ok(three)
  signIns.tabGone('t1')
  assert.deepEqual(signIns.list(), [])
})

test('没能安全地重新打开：原来的卡片换成“标签已关掉”，标签没了也留着，只能点知道了，到点也撤', () => {
  const timers: Array<() => void> = []
  const signIns = createSignIns({ schedule: (run) => void timers.push(run) })
  const owner = { deviceId: 'local', threadId: 'a' }
  const input = { owner, tabId: 't1', origin: 'https://a.example', site: 's', reason: 'r' }
  const one = signIns.begin(input)
  assert.ok(one)
  signIns.withdraw(one.id)
  signIns.closed(input)
  const [card] = signIns.list()
  assert.equal(signIns.list().length, 1)
  assert.equal(card?.state, 'closed')
  assert.equal(card?.origin, 'https://a.example')
  // 随后标签被关掉：这一张不撤
  signIns.tabGone('t1')
  assert.equal(signIns.list().length, 1)
  assert.ok(card)
  assert.equal(signIns.answer(card.id, 'done'), false)
  assert.equal(signIns.answer(card.id, 'cancel'), false)
  assert.equal(signIns.answer(card.id, 'dismiss'), true)
  assert.deepEqual(signIns.list(), [])
  signIns.closed(input)
  timers.at(-1)?.()
  assert.deepEqual(signIns.list(), [])
})

test('交接里开的弹窗：弹窗里再开的也记在同一次交接下，取走时一并取走', () => {
  const fake = (id: number) => ({ id, once() {} }) as unknown as WebContents
  const info = () => ({}) as never
  registerAutofillTab(fake(901), { kind: 'agent', info })
  // 没交出去的标签开的弹窗不算
  assert.equal(handoverOf(901, 'a1'), null)
  setHandedOver(901, true)
  assert.equal(handoverOf(901, 'a1'), 901)
  notePopup(901, 'p1')
  // p1 是用户的标签（webContents 902），没交出去，但它是这次交接里开的弹窗
  assert.equal(handoverOf(902, 'p1'), 901)
  notePopup(901, 'p2')
  assert.equal(isHandoverPopup('p2'), true)
  assert.equal(handoverOf(903, 'p3'), null)
  setHandedOver(901, false)
  assert.deepEqual(takePopups(901).sort(), ['p1', 'p2'])
  assert.equal(isHandoverPopup('p1'), false)
  assert.equal(handoverOf(902, 'p1'), null)
})

test('封闭的影子树里有输入框：算清不到（重新打开）；开放的、普通的不算', () => {
  const page = (shadow: string, field = 'INPUT'): DomNode => ({
    nodeName: '#document',
    children: [
      {
        nodeName: 'HTML',
        children: [
          {
            nodeName: 'DIV',
            shadowRoots: [
              {
                nodeName: '#document-fragment',
                shadowRootType: shadow,
                children: [{ nodeName: field }],
              },
            ],
          },
        ],
      },
    ],
  })
  assert.equal(hasClosedShadowFields(page('closed')), true)
  assert.equal(hasClosedShadowFields(page('closed', 'textarea')), true)
  assert.equal(hasClosedShadowFields(page('open')), false)
  assert.equal(hasClosedShadowFields(page('closed', 'SPAN')), false)
  // 同进程子框架里的封闭影子树
  assert.equal(hasClosedShadowFields({ nodeName: 'IFRAME', contentDocument: page('closed') }), true)
})

/** 交接直接回给定的结果（Litch 代填那几种），记下执行器交过来的东西 */
function scriptedSetup(outcome: (page: BrowserPage, host: BrowserHost) => SignInOutcome) {
  const asks: SignInAsk[] = []
  const host = fakeHost(() => false)
  const handover: BrowserHandover = {
    active: () => false,
    hides: () => false,
    markScripted() {},
    async request(page, ask) {
      asks.push(ask)
      return outcome(page, host)
    },
  }
  const executor = createBrowserExecutor({ host, sites: createSiteBook(null), handover })
  let seq = 0
  const shown: unknown[] = []
  const run = (
    tool: string,
    args: unknown = {},
    task: { id: string; name: string } | null = null,
  ) =>
    executor.call(
      {
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
        task,
      },
      {
        signal: new AbortController().signal,
        ask: async () => null,
        show(ask) {
          shown.push(ask)
          return () => {}
        },
      },
    )
  return { run, asks, host, shown }
}

const filled = (
  extra: Partial<Extract<SignInOutcome, { kind: 'filled' }>> = {},
): SignInOutcome => ({
  kind: 'filled',
  origin: 'http://localhost:3000',
  navigated: true,
  reopened: null,
  verification: false,
  stillSignIn: false,
  preauthorized: false,
  ...extra,
})

test('Litch 代填了：只说用了人批准的账号、页面换到哪，不带用户名；定时任务、回合、对话卡片的口子交给交接', async () => {
  const { run, asks } = scriptedSetup(() => filled())
  await run('navigate', { url: 'http://localhost:3000/login' })
  const reply = await run(
    'request_sign_in',
    { reason: 'Need access.' },
    { id: 'task-1', name: '日报' },
  )
  const text = textOf(reply)
  assert.equal(reply.success, true)
  assert.match(text, /Litch filled the account the user approved and submitted the sign-in/)
  assert.match(text, /the page loaded http:\/\/localhost:3000/)
  assert.match(text, /Take a fresh snapshot/)
  assert.doesNotMatch(text, /did not load a new document/)
  const [ask] = asks
  assert.ok(ask)
  assert.deepEqual(ask.task, { id: 'task-1', name: '日报' })
  assert.equal(ask.turnId, 'turn-1')
  assert.equal(ask.hintToken, null)
  assert.equal(ask.submitHint, false)
  assert.equal(ask.origin, null)
  assert.equal(typeof ask.show, 'function')
})

test('Litch 代填的几种说法：没换文档、要验证码、还停在登录页、事先授权、关掉重开换了标签', async () => {
  const say = async (outcome: SignInOutcome) => {
    const { run } = scriptedSetup(() => outcome)
    await run('navigate', { url: 'http://localhost:3000/login' })
    return textOf(await run('request_sign_in', { reason: 'r' }))
  }
  assert.match(
    await say(filled({ navigated: false })),
    /did not load a new document; Litch cleared/,
  )
  assert.match(
    await say(filled({ verification: true })),
    /extra verification.*`request_sign_in` again/,
  )
  assert.match(await say(filled({ stillSignIn: true })), /still shows a sign-in form/)
  assert.match(
    await say(filled({ preauthorized: true })),
    /the account the user authorized in advance for this task/,
  )
  // 关掉重开：之后不给 tabId 的调用落在新标签上
  const { run } = scriptedSetup((page, host) => {
    host.close(page.id)
    const next = host.open(page.info().owner, 'agent')
    void next.load('http://localhost:3000/home', 1000)
    return filled({ reopened: next.id })
  })
  await run('navigate', { url: 'http://localhost:3000/login' })
  const moved = textOf(await run('request_sign_in', { reason: 'r' }))
  assert.match(moved, /closed that tab and opened http:\/\/localhost:3000\/home in a new tab t2/)
  const after = await run('tabs', { action: 'list' })
  assert.match(textOf(after), /t2/)
  const snap = await run('snapshot')
  assert.equal(snap.success, true, textOf(snap))
})

test('代填做不了、源对不上、过期、同回合拒绝过：各自的说法', async () => {
  const say = async (outcome: SignInOutcome, args: Record<string, unknown> = {}) => {
    const { run } = scriptedSetup(() => outcome)
    await run('navigate', { url: 'http://localhost:3000/login' })
    return textOf(await run('request_sign_in', { reason: 'r', ...args }))
  }
  const failed = await say({ kind: 'fillFailed', why: 'insecure', reopened: null })
  assert.match(failed, /could not sign in to localhost:3000 automatically: insecure/)
  assert.match(failed, /`request_sign_in` again so the user can sign in themselves/)
  assert.match(
    await say({ kind: 'fillFailed', why: 'popup_needed', reopened: 't9' }),
    /popup_needed.*new tab t9/,
  )
  assert.match(
    await say('origin_changed', { origin: 'https://github.com' }),
    /not on https:\/\/github.com, so no sign-in was requested/,
  )
  assert.match(await say('expired'), /expired before anyone answered/)
  assert.match(await say('declined'), /declined signing in/)
})

test('编号提示：冻结之前给指的元素加一次性标记，口令交给交接；不认识的编号直接失败', async () => {
  const { run, asks, host } = scriptedSetup(() => filled())
  await run('navigate', { url: 'http://localhost:3000/login' })
  const page = host.page('t1')
  assert.ok(page)
  const sent: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
  const plain = page.cdp.bind(page)
  page.cdp = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    sent.push({ method, params })
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
          {
            nodeId: '2',
            parentId: '1',
            role: { value: 'textbox' },
            name: { value: 'Email' },
            backendDOMNodeId: 7,
          },
        ],
      } as T
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'o7' } } as T
    return plain<T>(method, params)
  }
  const snap = textOf(await run('snapshot'))
  const ref = /\[ref=(e\d+)\]/.exec(snap)?.[1]
  assert.ok(ref, snap)
  const bad = await run('request_sign_in', { reason: 'r', passwordRef: 'e99' })
  assert.equal(bad.success, false)
  assert.match(textOf(bad), /unknown ref e99/)
  assert.equal(asks.length, 0)
  await run('request_sign_in', { reason: 'r', usernameRef: ref, submitRef: ref })
  const [ask] = asks
  assert.ok(ask?.hintToken)
  assert.equal(ask.submitHint, true)
  assert.deepEqual(sent.find((one) => one.method === 'DOM.resolveNode')?.params, {
    backendNodeId: 7,
  })
  const marks = sent
    .filter((one) => one.method === 'Runtime.callFunctionOn')
    .map((one) => ((one.params?.arguments ?? []) as Array<{ value: string }>)[0]?.value)
  assert.deepEqual(marks, [`${ask.hintToken}:username`, `${ask.hintToken}:submit`])
})

test('代理给的源规范成 scheme://host[:port] 交给交接；认不出的当参数错', async () => {
  const { run, asks } = scriptedSetup(() => filled())
  await run('navigate', { url: 'http://localhost:3000/login' })
  await run('request_sign_in', { reason: 'r', origin: 'https://GitHub.com/login/' })
  assert.equal(asks[0]?.origin, 'https://github.com')
  const bad = await run('request_sign_in', { reason: 'r', origin: 'github' })
  assert.equal(bad.success, false)
  assert.match(textOf(bad), /origin must look like/)
  assert.equal(asks.length, 1)
})
