// 执行器的单元测试：假的宿主（不起 Electron），ask 用桩。量的是和具体网页无关的规矩：
// 参数校验、按来源审批的各种答复、只许动这个会话里代理自己的标签、导航闸门、回合收尾、上传只给本机会话。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolCallResponse } from '../../../../../packages/protocol/src/client-tools.mjs'
import type {
  ClientToolAnswer,
  ClientToolAsk,
  ClientToolInvocation,
} from '../../client-tools/types.mjs'
import { CdpRefused, isAllowedCdp } from '../cdp-allow.mjs'
import { createBrowserExecutor } from '../executor.mjs'
import type { BrowserHost, BrowserPage, DialogInfo, TabInfo, TabKind, TabOwner } from '../model.mjs'
import { createSiteBook } from '../sites.mjs'

interface FakePage extends BrowserPage {
  owner: TabOwner
  kind: TabKind
  keep: boolean
  active: boolean
  released: number
  url: string
  sent: string[]
}

function fakeHost() {
  const pages = new Map<string, FakePage>()
  let seq = 0
  let gate: (page: BrowserPage, url: string) => boolean = () => true
  const shown: string[] = []
  const host: BrowserHost & { gate(page: BrowserPage, url: string): boolean; shown: string[] } = {
    shown,
    gate: (page, url) => gate(page, url),
    pages: () => [...pages.values()],
    page: (id) => pages.get(id),
    open(owner, kind, options = {}) {
      const id = `t${++seq}`
      const page: FakePage = {
        id,
        owner,
        kind,
        keep: options.keep === true,
        active: false,
        released: 0,
        url: 'about:blank',
        sent: [],
        info: (): TabInfo => ({
          id,
          owner: page.owner,
          kind: page.kind,
          url: page.url,
          title: `title of ${page.url}`,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          agentActive: page.active,
          keep: page.keep,
        }),
        async load(url) {
          page.url = url
          return { ok: true }
        },
        history: async () => ({ ok: true }),
        waitForLoad: async () => true,
        async cdp<T>(method: string): Promise<T> {
          if (!isAllowedCdp(method)) throw new CdpRefused(method)
          page.sent.push(method)
          if (method === 'Page.getFrameTree')
            return { frameTree: { frame: { id: 'f', url: page.url } } } as T
          if (method === 'Accessibility.getFullAXTree') {
            return {
              nodes: [
                { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
                {
                  nodeId: '2',
                  parentId: '1',
                  role: { value: 'button' },
                  name: { value: 'OK' },
                  backendDOMNodeId: 7,
                },
              ],
            } as T
          }
          if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } } as T
          if (method === 'DOM.getContentQuads')
            return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] } as T
          return {} as T
        },
        consoleEntries: () => [],
        clearConsole() {},
        dialog: (): DialogInfo | null => null,
        dialogOpened: () => new Promise<DialogInfo>(() => {}),
        takeNotices: () => [],
        setAgentActive(active) {
          page.active = active
        },
        pointAt: async () => {},
      }
      pages.set(id, page)
      return page
    },
    close: (id) => void pages.delete(id),
    setKeep(id, keep) {
      const page = pages.get(id)
      if (page) page.keep = keep
    },
    release(id) {
      const page = pages.get(id)
      if (!page) return
      page.released++
      page.active = false
    },
    show: (id) => void shown.push(id),
    setNavigationGate(next) {
      gate = next
    },
  }
  return host
}

function setup() {
  const host = fakeHost()
  const sites = createSiteBook(null)
  const executor = createBrowserExecutor({
    host,
    sites,
    statFile: (path) => (path === '/tmp/a.txt' ? { file: true, size: 2 } : null),
  })
  const asked: ClientToolAsk[] = []
  let answers: Array<ClientToolAnswer | null> = []
  let turn = 1
  let seq = 0
  const run = (
    tool: string,
    args: unknown = {},
    options: { threadId?: string; remote?: boolean } = {},
  ): Promise<ClientToolCallResponse> => {
    const invocation: ClientToolInvocation = {
      id: `i${++seq}`,
      threadId: options.threadId ?? 'a',
      turnId: `turn-${turn}`,
      callId: `c${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device: options.remote
        ? { id: 'build', name: 'build', kind: 'ssh', target: 'build' }
        : { id: 'local', name: 'Mac', kind: 'local', target: null },
      harness: 'pi',
      cwd: null,
    }
    return executor.call(invocation, {
      signal: new AbortController().signal,
      ask: async (ask) => {
        asked.push(ask)
        return answers.shift() ?? null
      },
    })
  }
  const answer = (...next: Array<ClientToolAnswer | null>) => {
    answers = next
  }
  const endTurn = (threadId = 'a') => {
    executor.turnEnded({ deviceId: 'local', threadId, turnId: `turn-${turn}` })
    turn++
  }
  return { host, sites, executor, asked, answer, run, endTurn }
}

const text = (reply: ClientToolCallResponse) =>
  reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')

test('不认识的工具、参数不对回 invalid', async () => {
  const { run } = setup()
  assert.match(text(await run('nope')), /^\[litch:invalid\] unknown tool nope/)
  assert.match(text(await run('navigate', 'x')), /^\[litch:invalid\] arguments must be an object/)
  assert.match(text(await run('navigate', { url: 3 })), /^\[litch:invalid\] `url` must be a string/)
  assert.match(
    text(await run('snapshot')),
    /^\[litch:invalid\] this conversation has no browser tab/,
  )
  assert.match(text(await run('tabs', { action: 'fly' })), /must be one of/)
})

test('本机地址不问，外面的网站按答复走', async () => {
  const { run, asked, answer, endTurn, sites } = setup()
  assert.equal((await run('navigate', { url: 'http://localhost:3000/' })).success, true)
  assert.equal(asked.length, 0)

  answer('decline')
  const declined = await run('navigate', { url: 'https://example.com/a' })
  assert.equal(declined.success, false)
  assert.match(text(declined), /^\[litch:declined\] .*Do not try to reach this site another way/)
  assert.deepEqual(asked[0], {
    kind: 'site',
    origin: 'https://example.com',
    url: 'https://example.com/a',
  })
  // 同一回合里不再问
  await run('navigate', { url: 'https://example.com/b' })
  assert.equal(asked.length, 1)

  endTurn()
  answer('once')
  // 留给用户：回合结束不关，下一回合接着读
  assert.equal((await run('navigate', { url: 'https://example.com/', keep: true })).success, true)
  assert.equal((await run('snapshot')).success, true)
  assert.equal(asked.length, 2)
  endTurn()
  // “这一次”过了回合就不算：读页面又要问
  answer('session')
  assert.equal((await run('snapshot')).success, true)
  assert.equal(asked.length, 3)
  endTurn()
  assert.equal((await run('navigate', { url: 'https://example.com/z' })).success, true)
  assert.equal(asked.length, 3)
  // 别的会话不算
  answer('always')
  assert.equal(
    (await run('navigate', { url: 'https://example.com/' }, { threadId: 'b' })).success,
    true,
  )
  assert.equal(asked.length, 4)
  assert.deepEqual(
    sites.saved().map((one) => one.origin),
    ['https://example.com'],
  )
  assert.equal(
    (await run('navigate', { url: 'https://example.com/' }, { threadId: 'c' })).success,
    true,
  )
  assert.equal(asked.length, 4)
  // 没答就被取消
  answer(null)
  assert.match(
    text(await run('navigate', { url: 'https://other.test/' })),
    /^\[litch:failed\] the approval/,
  )
  // 不能开的协议不问
  assert.match(
    text(await run('navigate', { url: 'file:///etc/passwd' })),
    /^\[litch:invalid\].*http\.server/,
  )
  assert.equal(asked.length, 5)
})

test('导航闸门：只放本机和已经允许的来源', async () => {
  const { run, host, answer, endTurn } = setup()
  await run('navigate', { url: 'http://localhost/' })
  const page = host.pages()[0] as BrowserPage
  assert.equal(host.gate(page, 'http://127.0.0.1:9/x'), true)
  assert.equal(host.gate(page, 'https://evil.test/'), false)
  answer('once')
  await run('navigate', { url: 'https://good.test/' })
  assert.equal(host.gate(page, 'https://good.test/next'), true)
  endTurn()
  assert.equal(host.gate(page, 'https://good.test/next'), false)
})

test('信任所有网站：不问，黑名单里的（含子域名）回拒绝，闸门同样拦', async () => {
  const { run, host, asked, sites } = setup()
  sites.setTrustAll(true)
  sites.block('bank.test')
  assert.equal((await run('navigate', { url: 'https://example.com/' })).success, true)
  assert.equal((await run('navigate', { url: 'https://other.test/a' })).success, true)
  assert.equal(asked.length, 0)
  const refused = await run('navigate', { url: 'https://www.bank.test/login' })
  assert.equal(refused.success, false)
  assert.match(
    text(refused),
    /^\[litch:declined\] https:\/\/www\.bank\.test is on the user's blocklist/,
  )
  assert.equal(asked.length, 0)
  const page = host.pages()[0] as BrowserPage
  assert.equal(host.gate(page, 'https://anything.test/'), true)
  assert.equal(host.gate(page, 'https://bank.test/'), false)
  assert.equal(host.gate(page, 'https://notbank.test/'), true)
  // 关掉之后照常问，黑名单不起作用
  sites.setTrustAll(false)
  assert.equal(host.gate(page, 'https://anything.test/'), false)
  assert.equal(host.gate(page, 'https://bank.test/'), false)
})

test('只许动这个会话里代理自己的标签', async () => {
  const { run, host } = setup()
  const user = host.open({ deviceId: 'local', threadId: 'a' }, 'user')
  const reply = await run('click', { tabId: user.id, x: 1, y: 1 })
  assert.match(text(reply), /belongs to the user/)
  await run('navigate', { url: 'http://localhost/' })
  const mine = host.pages().find((one) => one.info().kind === 'agent') as BrowserPage
  assert.match(
    text(await run('snapshot', { tabId: mine.id }, { threadId: 'b' })),
    /no tab t2 in this conversation/,
  )
  const listed = text(await run('tabs', { action: 'list' }))
  assert.match(listed, /"owner": "user"/)
  assert.match(listed, /"owner": "you"/)
  // 用户的标签可以拿出来给用户看
  assert.equal((await run('show', { tabId: user.id })).success, true)
})

test('快照带编号，点击按编号找元素', async () => {
  const { run, host } = setup()
  await run('navigate', { url: 'http://localhost/' })
  const snapshot = text(await run('snapshot'))
  assert.match(snapshot, /- button "OK" \[ref=e1\]/)
  const clicked = await run('click', { ref: 'e1' })
  assert.equal(clicked.success, true, text(clicked))
  const page = host.pages()[0] as FakePage
  assert.ok(page.sent.includes('Input.dispatchMouseEvent'))
  assert.match(text(await run('click', { ref: 'e99' })), /unknown ref e99/)
  assert.match(text(await run('click', {})), /give `ref`/)
  assert.match(
    text(await run('snapshot', { diff: true })),
    /no changes since the previous snapshot/,
  )
})

test('回合收尾：关临时标签、留下标了留给用户的、松开别的', async () => {
  const { run, host, endTurn, executor } = setup()
  await run('navigate', { url: 'http://localhost/a' })
  await run('tabs', { action: 'new', url: 'http://localhost/b', keep: true })
  await run('tabs', { action: 'new' })
  const user = host.open({ deviceId: 'local', threadId: 'a' }, 'user') as FakePage
  const other = host.open({ deviceId: 'local', threadId: 'b' }, 'agent') as FakePage
  assert.equal(host.pages().length, 5)
  endTurn()
  const left = host.pages().map((one) => one.id)
  assert.equal(left.length, 3)
  const kept = host.pages().find((one) => one.info().keep) as FakePage
  assert.ok(kept)
  assert.equal(kept.released, 1)
  assert.equal(kept.active, false)
  assert.equal(user.released, 1)
  // 别的会话的不动
  assert.equal(other.released, 0)
  assert.ok(left.includes(other.id))
  // 当前标签没了就退到留下的那个
  assert.equal((await run('snapshot')).success, true)
  assert.equal(executor.currentTab('local', 'a'), kept.id)
})

test('上传：只给本机的会话、路径要是绝对的文件', async () => {
  const { run } = setup()
  await run('navigate', { url: 'http://localhost/' })
  await run('snapshot')
  assert.match(
    text(await run('upload', { ref: 'e1', paths: ['/tmp/a.txt'] }, { remote: true })),
    /^\[litch:invalid\] upload is only available/,
  )
  assert.match(text(await run('upload', { ref: 'e1', paths: ['a.txt'] })), /not an absolute path/)
  assert.match(text(await run('upload', { ref: 'e1', paths: ['/tmp/none'] })), /not a file/)
  assert.match(text(await run('upload', { ref: 'e1', paths: [] })), /non-empty array/)
})

test('远程设备上的会话打开 localhost 时提醒模型', async () => {
  const { run } = setup()
  const reply = await run('navigate', { url: 'http://localhost:5173/' }, { remote: true })
  assert.match(text(reply), /runs on the remote device "build"/)
})

test('show 交给宿主', async () => {
  const { run, host } = setup()
  assert.match(text(await run('show')), /no tab to show/)
  await run('navigate', { url: 'http://localhost/' })
  assert.equal((await run('show')).success, true)
  assert.equal(host.shown.length, 1)
})

test('被取消时当场回失败', async () => {
  const host = fakeHost()
  const executor = createBrowserExecutor({ host, sites: createSiteBook(null) })
  const controller = new AbortController()
  const reply = executor.call(
    {
      id: 'i1',
      threadId: 'a',
      turnId: 't1',
      callId: 'c1',
      namespace: 'litch_browser',
      tool: 'navigate',
      arguments: { url: 'https://slow.test/' },
      device: { id: 'local', name: 'Mac', kind: 'local', target: null },
      harness: null,
      cwd: null,
    },
    // 审批卡片一直没人答，回合被打断
    { signal: controller.signal, ask: () => new Promise(() => {}) },
  )
  controller.abort()
  assert.match(text(await reply), /^\[litch:failed\] the call was cancelled/)
})
