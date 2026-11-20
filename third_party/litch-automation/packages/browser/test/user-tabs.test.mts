import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserExecutor } from '../src/browser/executor.mjs'
import { createSiteBook } from '../src/browser/sites.mjs'
import type { ClientToolInvocation } from '../src/tool-port.mjs'
import { fakeHost } from './fake-cdp.mjs'

const text = (reply: any) =>
  reply.contentItems
    .filter((item: any) => item.type === 'inputText')
    .map((item: any) => item.text)
    .join('\n')
function fixture() {
  const host = fakeHost(),
    sites = createSiteBook(null)
  const executor = createBrowserExecutor({ host, sites })
  const page = host.open({ deviceId: 'original', threadId: 'user-session' }, 'user')
  let revision = 0
  page.inputRevision = () => revision
  const asked: unknown[] = []
  let answer: any = 'session'
  const call = (
    tool: string,
    args: unknown = {},
    threadId = 's',
    turnId = 't',
    signal = new AbortController().signal,
  ) =>
    executor.call(
      {
        id: 'i',
        callId: 'c',
        namespace: 'litch_browser',
        tool,
        arguments: args,
        device: { id: 'remote', name: 'Remote', kind: 'ssh', target: 'fixture' },
        threadId,
        turnId,
        cwd: null,
        harness: null,
      } as ClientToolInvocation,
      {
        signal,
        ask: async (ask) => {
          asked.push(ask)
          return typeof answer === 'function' ? answer() : answer
        },
      },
    )
  const token = async (thread = 's', turn = 't') =>
    JSON.parse(text(await call('tabs', { action: 'list' }, thread, turn))).tabs[0].claimToken
  return {
    host,
    sites,
    executor,
    page,
    asked,
    call,
    token,
    takeover: () => revision++,
    answer: (v: any) => {
      answer = v
    },
  }
}

test('跨设备会话看见全部用户标签；只有站点审批，租约独占，显式交还与回合结束从不关闭用户标签', async () => {
  const f = fixture()
  await f.page.load('https://fixture.test', 1000)
  const unclaimed = await f.call('snapshot', { tabId: f.page.id })
  assert.equal(unclaimed.success, false)
  assert.match(text(unclaimed), /"needs_claim":true/)
  const claimed = await f.call('claim', { claimToken: await f.token() })
  assert.equal(claimed.success, true, text(claimed))
  assert.deepEqual(
    f.asked.map((ask: any) => ask.kind),
    ['site'],
  )
  assert.equal(f.page.info().agentActive, true)
  assert.equal(f.page.info().owner.deviceId, 'original')
  assert.match(
    text(await f.call('ensure_claimed', { tabId: f.page.id }, 'other')),
    /another session/,
  )
  for (const action of ['close', 'keep'])
    assert.equal((await f.call('tabs', { tabId: f.page.id, action })).success, false)
  assert.equal((await f.call('release', { tabId: f.page.id })).success, true)
  assert.equal(f.host.page(f.page.id), f.page)
  assert.equal(f.page.info().agentActive, false)
  assert.equal((await f.call('ensure_claimed', { tabId: f.page.id }, 'other')).success, true)
  f.executor.turnEnded({ deviceId: 'remote', threadId: 's', turnId: 't' })
  assert.equal(f.page.info().agentActive, true, '旧会话收尾不能释放新控制者')
  f.executor.turnEnded({ deviceId: 'remote', threadId: 'other', turnId: 't' })
  assert.equal(f.page.info().agentActive, false)
  assert.ok(f.host.page(f.page.id))
})

test('信任所有网站仍守黑名单；站点拒绝不泄露内容，不给标签级卡片', async () => {
  const f = fixture()
  await f.page.load('https://blocked.test', 1000)
  f.sites.setTrustAll(true)
  f.sites.block('blocked.test')
  const denied = await f.call('claim', { claimToken: await f.token() })
  assert.equal(denied.success, false)
  assert.match(text(denied), /blocklist/)
  assert.equal(f.page.sent.length, 0)
  assert.equal(f.page.info().agentActive, false)
  f.sites.unblock('blocked.test')
  assert.equal((await f.call('ensure_claimed', { tabId: f.page.id })).success, true)
  assert.deepEqual(f.asked, [])
  await f.call('release', { tabId: f.page.id })
  f.sites.setTrustAll(false)
  f.answer('decline')
  assert.equal((await f.call('ensure_claimed', { tabId: f.page.id })).success, false)
  assert.deepEqual(
    f.asked.map((ask: any) => ask.kind),
    ['site'],
  )
})

test('用户接管及租约交还使旧引用失效；批量和下一回合不能偷用旧租约', async () => {
  const f = fixture()
  const first = await f.call('claim', { claimToken: await f.token() })
  const ref = /\[ref=([^\]]+)\]/.exec(text(first))?.[1]
  assert.ok(ref)
  f.takeover()
  assert.equal((await f.call('snapshot', { tabId: f.page.id })).success, false)
  assert.equal((await f.call('ensure_claimed', { tabId: f.page.id })).success, true)
  assert.equal((await f.call('click', { tabId: f.page.id, ref })).success, false)
  assert.equal(
    (
      await f.call('run_actions', {
        actions: [
          { tool: 'press', arguments: { tabId: f.page.id, key: 'Tab' } },
          { tool: 'press', arguments: { tabId: f.page.id, key: 'Enter' } },
        ],
      })
    ).success,
    true,
  )
  f.executor.turnEnded({ deviceId: 'remote', threadId: 's', turnId: 't' })
  assert.equal(
    (await f.call('press', { tabId: f.page.id, key: 'Enter' }, 's', 'next')).success,
    false,
  )
  assert.ok(f.host.page(f.page.id))
})

test('等待站点审批时回合结束，不重新取得租约或读页面；旧 token 不跨回合', async () => {
  const f = fixture()
  await f.page.load('https://approval.test', 1000)
  let allow!: (value: string) => void
  f.answer(
    () =>
      new Promise((resolve) => {
        allow = resolve
      }),
  )
  const token = await f.token()
  const work = f.call('claim', { claimToken: token })
  await new Promise((resolve) => setImmediate(resolve))
  f.executor.turnEnded({ deviceId: 'remote', threadId: 's', turnId: 't' })
  allow('session')
  assert.equal((await work).success, false)
  assert.equal(f.page.sent.length, 0)
  assert.equal(f.page.info().agentActive, false)
  assert.equal((await f.call('claim', { claimToken: token }, 's', 'next')).success, false)
})

test('并发操作同一标签被拒绝；读操作中用户接管后不交回读到的内容', async () => {
  const f = fixture()
  await f.call('claim', { claimToken: await f.token() })
  const cdp = f.page.cdp.bind(f.page)
  let resume!: () => void
  const waiting = new Promise<void>((resolve) => {
    resume = resolve
  })
  f.page.cdp = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (method === 'Accessibility.getFullAXTree') await waiting
    return cdp<T>(method, params)
  }
  const pending = f.call('snapshot', { tabId: f.page.id })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(text(await f.call('press', { tabId: f.page.id, key: 'Tab' })), /action in progress/)
  f.takeover()
  resume()
  const result = await pending
  assert.equal(result.success, false)
  assert.doesNotMatch(text(result), /button "OK"/)
})

test('调用被打断立即归还用户标签，不关闭页面或阻挡另一会话接手', async () => {
  const f = fixture()
  await f.call('claim', { claimToken: await f.token() })
  const controller = new AbortController()
  const waiting = f.call(
    'wait',
    { tabId: f.page.id, for: 'time', ms: 100 },
    's',
    't',
    controller.signal,
  )
  controller.abort()
  assert.equal((await waiting).success, false)
  assert.equal(f.page.info().agentActive, false)
  assert.equal(f.host.page(f.page.id), f.page)
  assert.equal((await f.call('ensure_claimed', { tabId: f.page.id }, 'other')).success, true)
})
