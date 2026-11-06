// 只使用此进程新建的隐藏视图、临时分区和假加密器；不访问真实钥匙串。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { createElectronHost, restoreBrowserCookies } from '../src/electron.mjs'
import { createCdpDriver, createSiteBook } from '../src/index.mjs'

const profile = process.env.BROWSER_FIXTURE_PROFILE
assert.ok(profile)
app.setPath('userData', profile)
app.setName('Browser Package Fixture')
app.commandLine.appendSwitch('use-mock-keychain')
BrowserWindow.prototype.show = () => {
  throw new Error('验收禁止显示窗口')
}
BrowserWindow.prototype.showInactive = () => {
  throw new Error('验收禁止显示窗口')
}
void app
  .whenReady()
  .then(async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<title>Host injection</title><button>Owned fixture</button>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const first = createElectronHost({
      partition: 'persist:external-one',
      autofillPreload: join(profile, 'empty-preload.cjs'),
      failurePage: () => 'about:blank',
      blockedDownload: (name) => `Blocked: ${name}`,
    })
    const second = createElectronHost({
      partition: 'persist:external-two',
      autofillPreload: join(profile, 'empty-preload.cjs'),
      failurePage: () => 'about:blank',
      blockedDownload: (name) => `Blocked: ${name}`,
    })
    const cipher = {
      available: () => true,
      encrypt: (plain: string) => Buffer.from(plain).toString('base64'),
      decrypt: (sealed: string) => Buffer.from(sealed, 'base64').toString(),
    }
    const state = await restoreBrowserCookies({
      partition: 'persist:external-one',
      file: join(profile, 'own-cookies.enc'),
      cipher,
    })
    const { driver } = createCdpDriver({
      hostId: 'fixture',
      host: first,
      sites: createSiteBook(null),
      onChange: first.onChange,
    })
    const scope = { hostId: 'fixture', deviceId: 'd', sessionId: 's', turnId: 't', callId: 'c' }
    const operation = { scope, signal: new AbortController().signal }
    const id = await driver.open(scope, { kind: 'agent', keep: false }, operation)
    assert.deepEqual(await driver.navigate(id, url, 10000, operation), { ok: true })
    const snapshot = await driver.snapshot(id, false, operation)
    assert.match(snapshot.text, /Owned fixture/)
    await driver.act(snapshot.observation, { kind: 'press', key: 'Tab' }, operation)
    await session
      .fromPartition('persist:external-one')
      .cookies.set({ url, name: 'isolated', value: 'fixture' })
    assert.equal(
      (await session.fromPartition('persist:external-two').cookies.get({ url })).length,
      0,
    )
    assert.equal((await session.defaultSession.cookies.get({ url })).length, 0)
    await state.flush()
    assert.equal(first.page(id)?.info().url, `${url}/`)
    assert.equal(session.fromPartition('persist:external-two').getPreloads().length, 0)
    await first.clearData()
    assert.equal(
      (await session.fromPartition('persist:external-one').cookies.get({ url })).length,
      0,
    )
    await driver.dispose()
    state.dispose()
    first.dispose()
    second.dispose()
    assert.throws(() => first.open({ deviceId: 'd', threadId: 's' }, 'agent'), /disposed/)
    server.close()
    console.log('BROWSER_PACKAGE_ELECTRON_OK')
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
