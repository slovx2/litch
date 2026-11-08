// 不启动 Electron，不读真实浏览器资料；展示宿主如何提供 CDP 页面和审批。
import assert from 'node:assert/strict'
import { createProtectedReader } from '../src/import.mjs'
import {
  browserToolsSpec,
  type CdpHost,
  type CdpPage,
  createBrowserExecutor,
  createCdpDriver,
  createSiteBook,
  type TabInfo,
} from '../src/index.mjs'

const pages = new Map<string, CdpPage>()
let sequence = 0
const host: CdpHost = {
  pages: () => [...pages.values()],
  page: (id) => pages.get(id),
  open(owner, kind, options) {
    const info: TabInfo = {
      id: `t${++sequence}`,
      owner,
      kind,
      url: 'about:blank',
      title: '独立宿主',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      agentActive: false,
      keep: options?.keep === true,
    }
    const page: CdpPage = {
      id: info.id,
      info: () => ({ ...info }),
      async load(url) {
        info.url = url
        return { ok: true }
      },
      history: async () => ({ ok: true }),
      waitForLoad: async () => true,
      async cdp<T>(method: string): Promise<T> {
        if (method === 'Page.getFrameTree')
          return { frameTree: { frame: { id: 'f', url: info.url } } } as T
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] } as T
        return {} as T
      },
      consoleEntries: () => [],
      clearConsole() {},
      dialog: () => null,
      dialogOpened: () => new Promise(() => {}),
      takeNotices: () => [],
      setAgentActive(active) {
        info.agentActive = active
      },
      pointAt: async () => {},
    }
    pages.set(page.id, page)
    return page
  },
  close(id) {
    pages.delete(id)
  },
  setKeep() {},
  release() {},
  show() {},
  // 真宿主必须在页面自发导航、重定向和弹窗之前调用这个门禁；本例没有网络。
  setNavigationGate() {},
}
const sites = createSiteBook(null)
const tools = createBrowserExecutor({ host, sites })
assert.ok(browserToolsSpec(true).tools.some((tool) => tool.name === 'request_sign_in'))
let asked = 0
const response = await tools.call(
  {
    id: 'c',
    callId: 'c',
    threadId: 's',
    turnId: 't',
    namespace: 'litch_browser',
    tool: 'navigate',
    arguments: { url: 'https://example.test' },
    device: { id: 'd', name: 'fixture', kind: 'local', target: null },
    harness: null,
    cwd: null,
  },
  {
    signal: new AbortController().signal,
    ask: async () => {
      asked++
      return 'once'
    },
  },
)
assert.equal(response.success, true)
assert.equal(asked, 1)
tools.turnEnded({ deviceId: 'd', threadId: 's', turnId: 't' })
assert.equal(pages.size, 0)

// 语义 API 和工具 profile 二选一接管同一 host；不要同时覆盖其导航闸。
const { driver } = createCdpDriver({ hostId: 'external', host, sites })
const scope = { hostId: 'external', deviceId: 'd', sessionId: 's', turnId: 'u', callId: 'v' }
const operation = { scope, signal: new AbortController().signal }
const id = await driver.open(scope, { kind: 'agent', keep: false }, operation)
await driver.snapshot(id, false, operation)
await driver.endSession(scope)
await driver.dispose()
// 读取器能力查询不访问文件、钥匙串或真实浏览器。
const reader = createProtectedReader({
  platform: 'linux',
  secrets: {
    keychain: async () => {
      throw new Error('本例禁止访问钥匙串')
    },
    unprotect: async () => {
      throw new Error('本例禁止访问系统秘密')
    },
  },
})
assert.deepEqual(reader.capabilities('chrome').kinds, [])
console.log('独立 Node 宿主通过')
