import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChromeGrant } from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { createSiteBook } from '../../browser/src/browser/sites.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../../browser/src/tool-port.mjs'
import { type ChromeBridge, ChromeBridgeError } from '../src/bridge.mjs'
import { ChromeExecutor } from '../src/executor.mjs'

const origin = 'https://atlas.test'
const frameOrigin = 'https://editor.atlas.test'
function fixture() {
  const tab = {
    id: 1,
    targetId: 'a'.repeat(32),
    generation: 1,
    loading: false,
    title: 'Atlas',
    url: origin + '/',
    origins: [origin],
    busy: false,
    active: true,
    lastFocusedWindow: true,
  }
  const sites = createSiteBook(null)
  sites.allowAlways(origin)
  let grant: ChromeGrant
  let commands = 0
  let authorizations = 0
  let ask: ClientToolContext['ask'] = async () => 'session'
  const asked: string[] = []
  const executor = new ChromeExecutor({
    namespace: 'atlas_browser',
    productName: 'Atlas',
    allowed: () => true,
    sites,
    bridge: {
      instances: () => [{ id: 'atlas', epoch: '1', inputReceipts: true }],
      onEvent: () => () => {},
      call: async (_id: string, request: { op: string; args: Record<string, any> }) => {
        if (request.op === 'list') return [structuredClone(tab)]
        if (request.op === 'claim') {
          grant = structuredClone(request.args.grant)
          return { tab: structuredClone(tab) }
        }
        if (request.op === 'authorize') {
          authorizations++
          grant.origins = request.args.origins
          return null
        }
        if (request.op === 'command') {
          commands++
          if (tab.origins.some((origin) => !grant.origins.includes(origin)))
            throw new ChromeBridgeError('originNotApproved', 'No page content was returned.')
          if (request.args.method === 'Accessibility.getFullAXTree')
            return {
              nodes: [
                {
                  nodeId: '1',
                  role: { value: 'heading' },
                  name: { value: 'APPROVED_FRAME_CONTENT' },
                  backendDOMNodeId: 1,
                },
              ],
            }
          return { frameTree: { frame: { id: 'main', url: tab.url } } }
        }
        return null
      },
    } as unknown as ChromeBridge,
  })
  const base: ClientToolInvocation = {
    id: 'atlas',
    callId: '',
    namespace: 'atlas_browser',
    tool: '',
    arguments: {},
    device: { id: 'device', name: 'Atlas', kind: 'local', target: null },
    threadId: 'session',
    turnId: 'turn',
    harness: null,
    cwd: null,
  }
  const context: ClientToolContext = {
    signal: new AbortController().signal,
    ask: async (request) => {
      if (request.kind === 'site') asked.push(request.origin)
      return ask(request)
    },
  }
  let seq = 0
  const call = (tool: string, args: Record<string, unknown>) =>
    executor.call({ ...base, callId: String(++seq), tool, arguments: args }, context)
  const start = async () => {
    const listed = await call('tabs', { action: 'list', targetId: 'chrome:atlas' })
    const token = JSON.parse((listed.contentItems[0] as { text: string }).text).tabs[0].claimToken
    const claimed = await call('claim', { claimToken: token })
    assert.equal(claimed.success, true)
    return JSON.parse((claimed.contentItems[0] as { text: string }).text).tabId as string
  }
  return {
    executor,
    sites,
    tab,
    asked,
    start,
    call,
    commands: () => commands,
    authorizations: () => authorizations,
    ask: (next: typeof ask) => {
      ask = next
    },
    grant: () => grant,
  }
}
const text = (result: Awaited<ReturnType<ReturnType<typeof fixture>['call']>>) =>
  result.contentItems.map((item) => ('text' in item ? item.text : '')).join('\n')

for (const permission of ['trustAll', 'always', 'session', 'once'] as const) {
  test(`动态 iframe：${permission} 已允许的来源自动登记且不再审批`, async (t) => {
    const f = fixture()
    t.after(() => f.executor.dispose())
    const tabId = await f.start()
    if (permission === 'trustAll') f.sites.setTrustAll(true)
    else if (permission === 'always') f.sites.allowAlways(frameOrigin)
    else if (permission === 'session')
      f.sites.allowSession(JSON.stringify(['device', 'session']), frameOrigin)
    else f.sites.allowOnce(JSON.stringify(['device', 'session']), 'turn', frameOrigin)
    f.tab.origins.push(frameOrigin)
    const result = await f.call('snapshot', { tabId })
    assert.equal(result.success, true, text(result))
    assert.match(text(result), /APPROVED_FRAME_CONTENT/)
    assert.deepEqual(f.asked, [])
    assert.ok(f.grant().origins.includes(frameOrigin))
    assert.equal(f.authorizations(), 1)
  })
}

test('动态 iframe：信任所有网站仍尊重黑名单，不登记也不读内容', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const tabId = await f.start()
  f.sites.setTrustAll(true)
  f.sites.block('editor.atlas.test')
  f.tab.origins.push(frameOrigin)
  const result = await f.call('snapshot', { tabId })
  assert.equal(result.success, false)
  assert.match(text(result), /blocked/)
  assert.doesNotMatch(text(result), /APPROVED_FRAME_CONTENT/)
  assert.equal(f.commands(), 0)
  assert.equal(f.authorizations(), 0)
  assert.deepEqual(f.asked, [])
})

test('动态 iframe：审批卡完成前无页面内容，批准后才登记和读取', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const tabId = await f.start()
  f.tab.origins.push(frameOrigin)
  let entered!: () => void
  const asking = new Promise<void>((resolve) => {
    entered = resolve
  })
  let approve!: (value: 'session') => void
  f.ask(async () => {
    entered()
    return new Promise((resolve) => {
      approve = resolve
    })
  })
  const pending = f.call('snapshot', { tabId })
  await asking
  assert.equal(f.commands(), 0)
  assert.equal(f.authorizations(), 0)
  assert.deepEqual(f.asked, [frameOrigin])
  approve('session')
  const result = await pending
  assert.equal(result.success, true, text(result))
  assert.match(text(result), /APPROVED_FRAME_CONTENT/)
})

test('动态 iframe：用户拒绝后本回合不再弹卡也不泄漏内容', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const tabId = await f.start()
  f.tab.origins.push(frameOrigin)
  f.ask(async () => 'decline')
  for (let index = 0; index < 2; index++) {
    const result = await f.call('snapshot', { tabId })
    assert.equal(result.success, false)
    assert.doesNotMatch(text(result), /APPROVED_FRAME_CONTENT/)
  }
  assert.equal(f.commands(), 0)
  assert.equal(f.authorizations(), 0)
  assert.deepEqual(f.asked, [frameOrigin])
})

test('动态 iframe：审批期间租约撤销，批准不能恢复旧标签或读取内容', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  const tabId = await f.start()
  f.tab.origins.push(frameOrigin)
  f.ask(async () => {
    const page = f.executor.pages.get(tabId)
    assert.ok(page)
    page.valid = false
    page.recoverable = false
    return 'session'
  })
  const result = await f.call('snapshot', { tabId })
  assert.equal(result.success, false)
  assert.equal(f.commands(), 0)
  assert.equal(f.authorizations(), 0)
  assert.doesNotMatch(text(result), /APPROVED_FRAME_CONTENT/)
})
