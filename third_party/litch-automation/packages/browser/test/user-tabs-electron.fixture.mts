// 只用隐藏窗口、临时分区及回环站点；不触碰真实浏览器、用户页面或凭据。
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createElectronHost } from '../src/browser/electron-host.mjs'
import type { HostTab } from '../src/browser/electron-tab.mjs'
import { createBrowserExecutor } from '../src/browser/executor.mjs'
import { createHandover } from '../src/browser/passwords/handover.mjs'
import { createSignIns } from '../src/browser/passwords/signin.mjs'
import { notePopup } from '../src/browser/passwords/tabs.mjs'
import { createSiteBook } from '../src/browser/sites.mjs'

const profile = process.env.BROWSER_FIXTURE_PROFILE
assert.ok(profile)
app.setPath('userData', profile)
app.commandLine.appendSwitch('use-mock-keychain')
void app
  .whenReady()
  .then(async () => {
    let failedReload = false
    const server = createServer((request, response) => {
      if (request.url === '/unreload' && failedReload) {
        response.writeHead(204)
        response.end()
      } else if (request.url === '/file') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename=fixture.txt',
        })
        response.end('isolated download')
      } else {
        response.setHeader('content-type', 'text/html')
        response.end(
          '<title>User tab fixture</title><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#done\').textContent=\'Saved\'">Save</button><p id="done"></p><a href="/file">Download</a>',
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const host = createElectronHost({
      partition: 'user-tabs-fixture',
      autofillPreload: join(profile, 'empty-preload.cjs'),
      failurePage: () => 'about:blank',
      blockedDownload: () => 'blocked',
      downloads: {
        stagingRoot: join(profile, 'staging'),
        downloadsDirectory: join(profile, 'downloads'),
      },
    })
    const window = new BrowserWindow({ show: false, width: 900, height: 650 })
    const page = host.open({ deviceId: 'original', threadId: 'user' }, 'user') as HostTab
    await page.load(url, 10_000)
    host.place(window, page.id, { x: 0, y: 0, width: 900, height: 650 })
    const handover = createHandover({ host, signIns: createSignIns() })
    const executor = createBrowserExecutor({ host, sites: createSiteBook(null), handover })
    const asks: string[] = []
    const call = (tool: string, args: unknown = {}, threadId = 'remote-session', turnId = 'turn') =>
      executor.call(
        {
          id: 'i',
          callId: 'c',
          namespace: 'litch_browser',
          tool,
          arguments: args,
          threadId,
          turnId,
          device: { id: 'remote', name: 'Remote fixture', kind: 'ssh', target: 'fake' },
          cwd: null,
          harness: null,
        },
        {
          signal: new AbortController().signal,
          ask: async (ask) => {
            asks.push(ask.kind)
            return ask.kind === 'browserDownload' ? 'once' : 'session'
          },
        },
      )
    const text = (r: any) =>
      r.contentItems
        .filter((i: any) => i.type === 'inputText')
        .map((i: any) => i.text)
        .join('\n')
    const ok = async (tool: string, args: unknown = {}) => {
      const r = await call(tool, args)
      assert.equal(r.success, true, text(r))
      return text(r)
    }
    const observed = await ok('claim', {
      claimToken: JSON.parse(await ok('tabs', { action: 'list' })).tabs[0].claimToken,
    })
    assert.equal(page.info().agentActive, true)
    assert.equal(page.info().controller?.deviceId, 'remote')
    assert.equal(page.info().owner.deviceId, 'original')
    assert.equal((await call('ensure_claimed', { tabId: page.id }, 'other')).success, false)
    const ref = (snapshot: string, label: string) => {
      const value = snapshot
        .split('\n')
        .find((line) => line.includes(label))
        ?.match(/\[ref=([^\]]+)\]/)?.[1]
      assert.ok(value, snapshot)
      return value
    }
    await ok('type', {
      tabId: page.id,
      ref: ref(observed, 'textbox "Name"'),
      text: 'agent fixture',
      clear: true,
    })
    await ok('press', { tabId: page.id, key: 'Tab' })
    assert.equal(page.info().agentActive, true, 'CDP 输入不能当作用户接管')
    const batch = await ok('run_actions', {
      actions: [
        { tool: 'click', arguments: { tabId: page.id, ref: ref(observed, 'button "Save"') } },
        { tool: 'wait', arguments: { tabId: page.id, for: 'text', text: 'Saved' } },
      ],
    })
    assert.match(batch, /Saved/)
    const revision = page.inputRevision?.()
    // sendInputEvent 走 Chromium 原生事件，模拟用户直接点网页，和 CDP 工具输入分开。
    page.view.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
    page.view.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
    const until = async (find: () => boolean) => {
      const deadline = Date.now() + 5000
      while (!find()) {
        assert.ok(Date.now() < deadline, '等待用户接管/下载超时')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    await until(() => page.inputRevision?.() !== revision)
    assert.equal(page.info().agentActive, false)
    // 接管只交还用户标签；用户查看代理标签不能撤销代理归属或断开 CDP。
    const agent = host.open({ deviceId: 'remote', threadId: 'remote-session' }, 'agent') as HostTab
    await agent.load(url, 5000)
    await agent.cdp('Runtime.evaluate', { expression: 'document.title' })
    agent.setAgentActive(true)
    const agentRevision = agent.inputRevision?.()
    agent.view.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
    agent.view.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 20,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
    await until(() => agent.inputRevision?.() !== agentRevision)
    assert.equal(agent.info().agentActive, true, '用户输入不撤销代理标签归属')
    assert.equal(agent.view.webContents.debugger.isAttached(), true)
    host.close(agent.id)
    assert.equal((await call('press', { tabId: page.id, key: 'Enter' })).success, false)
    const reclaimed = await ok('ensure_claimed', { tabId: page.id })
    await ok('click', { tabId: page.id, ref: ref(reclaimed, 'link "Download"') })
    await until(() => host.downloads?.list()[0]?.status === 'completed')
    assert.deepEqual(host.downloads?.list()[0]?.owner, {
      deviceId: 'remote',
      threadId: 'remote-session',
    })
    assert.deepEqual(asks, ['browserDownload'], '回环站点免站点卡；只有代理下载卡，无标签/实例卡')
    executor.turnEnded({ deviceId: 'remote', threadId: 'remote-session', turnId: 'turn' })
    assert.equal(host.page(page.id), page)
    assert.equal(page.info().agentActive, false)
    assert.equal(page.view.webContents.isDestroyed(), false)
    const next = await call('ensure_claimed', { tabId: page.id }, 'remote-session', 'next')
    assert.equal(next.success, true, text(next))
    host.userNavigate(page.id, 'reload')
    assert.equal(page.info().agentActive, false)
    assert.equal(
      (await call('snapshot', { tabId: page.id }, 'remote-session', 'next')).success,
      false,
    )
    await page.load(`${url}/unreload`, 5000)
    assert.equal(
      (await call('ensure_claimed', { tabId: page.id }, 'remote-session', 'handover')).success,
      true,
    )
    assert.equal(
      (
        await call(
          'evaluate',
          { tabId: page.id, expression: 'document.title' },
          'remote-session',
          'handover',
        )
      ).success,
      true,
    )
    failedReload = true
    const loginPopup = host.open(page.info().owner, 'user') as HostTab
    await loginPopup.load(url, 5000)
    notePopup(page.view.webContents.id, loginPopup.id)
    const failedSignIn = await call(
      'request_sign_in',
      { tabId: page.id, reason: 'isolated failed reload' },
      'remote-session',
      'handover',
    )
    assert.match(text(failedSignIn), /remains open/)
    assert.equal(host.page(page.id), page, '登录交接失败也不能关闭用户原标签')
    assert.equal(host.page(loginPopup.id), loginPopup, '用户登录弹窗同样保留')
    assert.equal(handover.active(loginPopup.id), true)
    assert.equal(handover.active(page.id), true, '加载新文档前不能观察旧页面')
    failedReload = false
    host.userNavigate(page.id, 'reload')
    host.userNavigate(loginPopup.id, 'reload')
    await until(() => !handover.active(page.id))
    await until(() => !handover.active(loginPopup.id))
    assert.equal(
      (await call('ensure_claimed', { tabId: page.id }, 'remote-session', 'after-handover'))
        .success,
      true,
    )
    if (process.env.BROWSER_USER_TAB_SHOTS) {
      mkdirSync(process.env.BROWSER_USER_TAB_SHOTS, { recursive: true })
      await page.setAgentActive(true, { deviceId: 'remote', threadId: 'remote-session' })
      const shot = await page.cdp<any>('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        join(process.env.BROWSER_USER_TAB_SHOTS, 'user-tab-page.png'),
        Buffer.from(shot.data, 'base64'),
      )
    }
    host.downloads?.dispose()
    host.dispose()
    window.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    console.log(
      'BROWSER_USER_TABS_ELECTRON_OK claim/lease/input/takeover/batch/download/return/remote-owner',
    )
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
