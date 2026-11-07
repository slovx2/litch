import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserOperation } from '../../automation-contracts/src/browser.mjs'
import { createSiteBook } from '../src/browser/sites.mjs'
import { createCdpDriver } from '../src/cdp-driver.mjs'
import { fakeHost } from './fake-cdp.mjs'

function setup() {
  const host = fakeHost(),
    sites = createSiteBook(null),
    controller = new AbortController()
  const scope = { hostId: 'fixture', deviceId: 'local', sessionId: 's', turnId: 't', callId: 'c' }
  const op: BrowserOperation = { scope, signal: controller.signal }
  const runtime = createCdpDriver({ hostId: 'fixture', host, sites })
  return { host, sites, controller, scope, op, ...runtime }
}

test('语义驱动复用 CDP 读页/输入，只接受当前宿主/会话和已批准来源', async () => {
  const f = setup(),
    id = await f.driver.open(f.scope, { kind: 'agent', keep: false }, f.op)
  await assert.rejects(f.driver.navigate(id, 'https://example.test', 1000, f.op), /approved/)
  f.sites.allowAlways('https://example.test')
  await f.driver.navigate(id, 'https://example.test', 1000, f.op)
  const snapshot = await f.driver.snapshot(id, false, f.op)
  assert.match(snapshot.text, /button "OK"/)
  await f.driver.act(snapshot.observation, { kind: 'press', key: 'Tab' }, f.op)
  await assert.rejects(
    f.driver.snapshot(id, false, { ...f.op, scope: { ...f.scope, hostId: 'other' } }),
    /host/,
  )
  await assert.rejects(
    f.driver.snapshot(id, false, { ...f.op, scope: { ...f.scope, sessionId: 'other' } }),
    /owned/,
  )
  f.controller.abort()
  await assert.rejects(f.driver.act(snapshot.observation, { kind: 'press', key: 'Tab' }, f.op))
  await f.dispose()
})

test('导航换页后旧 ref、布局变更后旧坐标均拒绝；撤销来源前不发送 CDP', async () => {
  const f = setup(),
    id = await f.driver.open(f.scope, { kind: 'agent', keep: false }, f.op)
  f.sites.allowAlways('https://example.test')
  await f.driver.navigate(id, 'https://example.test/a', 1000, f.op)
  const snapshot = await f.driver.snapshot(id, false, f.op)
  await f.driver.navigate(id, 'https://example.test/b', 1000, f.op)
  await assert.rejects(
    f.driver.act(snapshot.observation, { kind: 'press', key: 'Tab' }, f.op),
    /changed/,
  )
  const page = f.host.page(id)
  assert.ok(page)
  const next = await f.driver.snapshot(id, false, f.op),
    cdp = page.cdp
  page.cdp = async <T,>(method: string) =>
    method === 'Page.getLayoutMetrics' ? ({ width: 42 } as T) : cdp(method)
  await assert.rejects(
    f.driver.act(
      next.observation,
      { kind: 'click', target: { kind: 'point', x: 1, y: 1 }, button: 'left', count: 1 },
      f.op,
    ),
    /changed/,
  )
  f.sites.forget()
  let sent = 0
  page.cdp = async <T,>() => {
    sent++
    return {} as T
  }
  await assert.rejects(f.driver.snapshot(id, false, f.op), /approved/)
  assert.equal(sent, 0)
  await f.dispose()
})

test('冻结进行中隐藏页面，可信交接结束后旧观察失效，附加导航闸不能放宽策略', async () => {
  const host = fakeHost(),
    sites = createSiteBook(null),
    scope = { hostId: 'h', deviceId: 'local', sessionId: 's', turnId: 't', callId: 'c' },
    op = { scope, signal: new AbortController().signal }
  let finish!: (value: string) => void
  const { driver, dispose } = createCdpDriver({
    hostId: 'h',
    host,
    sites,
    handover: {
      active: () => false,
      freeze: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      unfreeze: async () => {},
    },
  })
  const id = await driver.open(scope, { kind: 'agent', keep: false }, op),
    before = await driver.snapshot(id, false, op)
  const frozen = driver.freeze(id, op)
  await assert.rejects(driver.snapshot(id, false, op), /signing in/)
  assert.equal(driver.pages()[0]?.url, '')
  finish('trusted')
  await frozen
  await assert.rejects(driver.unfreeze(id, 'wrong', op), /Invalid/)
  await driver.unfreeze(id, 'trusted', op)
  await assert.rejects(driver.act(before.observation, { kind: 'press', key: 'Tab' }, op), /changed/)
  driver.setNavigationGate(() => true)
  const page = host.page(id)
  assert.ok(page)
  assert.equal(host.gate(page, 'https://forbidden.test'), false)
  await dispose()
})

test('取消正在等待的 CDP 后立即返回，迟到的回复不能继续输入', async () => {
  const f = setup()
  const id = await f.driver.open(f.scope, { kind: 'agent', keep: false }, f.op)
  const observed = await f.driver.snapshot(id, false, f.op)
  const page = f.host.page(id)
  assert.ok(page)
  const original = page.cdp
  let finish: (value: unknown) => void = () => {}
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let inputs = 0
  page.cdp = async <T,>(method: string): Promise<T> => {
    if (method.startsWith('Input.')) inputs++
    if (method === 'Page.getFrameTree') {
      entered()
      return new Promise<T>((resolve) => {
        finish = (value) => resolve(value as T)
      })
    }
    return original<T>(method)
  }
  const action = f.driver.act(observed.observation, { kind: 'press', key: 'Tab' }, f.op)
  await started
  f.controller.abort()
  await assert.rejects(action, /cancelled/)
  finish({ frameTree: { frame: { id: 'f', url: 'about:blank' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(inputs, 0)
  await f.dispose()
})
