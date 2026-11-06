// 用真实 guardedPage 复现：代理已冻结/已取消，但平台清理必须还能重载。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { HostTab } from '../electron-tab.mjs'
import { guardedPage } from '../guarded-page.mjs'
import type { BrowserHost } from '../model.mjs'
import { refreshHandoverPage } from '../passwords/handover-refresh.mjs'

function fixture(url = 'https://example.test/login') {
  const events = new EventEmitter()
  let destroyed = false
  const contents = Object.assign(events, {
    isDestroyed: () => destroyed,
    getURL: () => url,
  }) as unknown as WebContents
  const calls: unknown[][] = []
  let navigate = true
  const load = async (...args: unknown[]) => {
    calls.push(args)
    if (navigate) events.emit('did-navigate')
    return { ok: navigate }
  }
  const page = {
    id: 'tab',
    view: { webContents: contents },
    load,
    history: load,
    dialog: () => null,
  } as unknown as HostTab
  let current: HostTab | undefined = page
  const host = { page: () => current } as unknown as BrowserHost
  return {
    host,
    page,
    contents,
    events,
    calls,
    setCurrent: (next: HostTab | undefined) => {
      current = next
    },
    destroy: () => {
      destroyed = true
    },
    noNavigation: () => {
      navigate = false
    },
  }
}

for (const reason of ['The user is signing in on this tab.', 'The call was cancelled.']) {
  test(`交接安全重载不受代理闸门影响：${reason}`, async () => {
    const f = fixture()
    const guarded = guardedPage(
      f.page,
      async () => {
        throw new Error(reason)
      },
      undefined,
      () => {},
      true,
    ).page
    await assert.rejects(guarded.load(f.contents.getURL(), 100), { message: reason })
    assert.equal(f.calls.length, 0, '代理仍然不能导航')
    assert.equal(await refreshHandoverPage(f.host, guarded, f.contents, 100), true)
    assert.deepEqual(f.calls, [['https://example.test/login', 100]])
    await assert.rejects(guarded.load(f.contents.getURL(), 100), { message: reason })
    assert.equal(f.calls.length, 1, '清理没有解除代理闸门')
    assert.equal(f.events.listenerCount('did-navigate'), 0)
    assert.equal(f.events.listenerCount('will-prevent-unload'), 0)
  })
}

test('没有新文档、导航出错或标签已失效时不交还；不会动替换后的标签', async () => {
  const f = fixture()
  f.noNavigation()
  assert.equal(await refreshHandoverPage(f.host, f.page, f.contents, 100), false, '204 没换文档')
  f.page.load = async () => {
    throw new Error('导航失败')
  }
  assert.equal(await refreshHandoverPage(f.host, f.page, f.contents, 100), false)
  assert.equal(f.events.listenerCount('did-navigate'), 0)
  assert.equal(f.events.listenerCount('will-prevent-unload'), 0)
  f.setCurrent(undefined)
  assert.equal(await refreshHandoverPage(f.host, f.page, f.contents, 100), false)
  const other = fixture()
  f.setCurrent(other.page)
  assert.equal(await refreshHandoverPage(f.host, f.page, f.contents, 100), false)
  assert.equal(other.calls.length, 0)
  f.setCurrent(f.page)
  f.destroy()
  assert.equal(await refreshHandoverPage(f.host, f.page, f.contents, 100), false)
})

test('空白页重载沿用 history，网页不能用 beforeunload 挡住安全清理', async () => {
  const f = fixture('about:blank')
  let prevented = false
  f.page.history = async () => {
    f.events.emit('will-prevent-unload', {
      preventDefault: () => {
        prevented = true
      },
    })
    f.events.emit('did-navigate')
    return { ok: true }
  }
  assert.equal(await refreshHandoverPage(f.host, f.page, f.contents, 100), true)
  assert.equal(prevented, true)
  assert.equal(f.calls.length, 0, '没有把 about:blank 当作 HTTP URL 加载')
})
