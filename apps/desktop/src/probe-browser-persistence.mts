// 正式宿主与持久化入口；两个本地假站点模拟登录，所有资料、Cookie、钥匙串替身都隔离。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, safeStorage, session } from 'electron'
import { type HostTab, PARTITION } from './browser/electron-tab.mjs'
import { installBrowser } from './browser/install.mjs'

const profile = process.env.LITCH_PROFILE
if (!profile) throw new Error('验收必须提供隔离 profile')
app.setPath('userData', profile)
app.commandLine.appendSwitch('use-mock-keychain')
app.commandLine.appendSwitch('disable-background-networking')
let step = '启动'
void app
  .whenReady()
  .then(async () => {
    app.dock?.hide()
    const stage = process.argv.at(-1)
    const server = createServer((request, response) => {
      if (request.url === '/login')
        response.setHeader('Set-Cookie', [
          'login-session=synthetic-login; Path=/; HttpOnly; SameSite=Lax',
          'login-persistent=synthetic-persist; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax',
        ])
      if (request.url === '/logout')
        response.setHeader(
          'Set-Cookie',
          'login-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        )
      response.end(
        `<p id="logged">${request.headers.cookie?.includes('login-session=synthetic-login') === true}</p>`,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const sites = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`] as const
    step = '安装浏览器'
    const browser = await installBrowser({ isUiUrl: () => false, userData: profile })
    browser.host.setNavigationGate(() => true)
    const user = browser.host.open({ deviceId: 'one', threadId: 'user' }, 'user') as HostTab
    const agent = browser.host.open({ deviceId: 'two', threadId: 'agent' }, 'agent') as HostTab
    assert.equal(user.view.webContents.session, agent.view.webContents.session)
    const cookies = session.fromPartition(PARTITION).cookies
    const snapshot = async () => {
      if (!agent.view.webContents.debugger.isAttached())
        agent.view.webContents.debugger.attach('1.3')
      return (await agent.view.webContents.debugger.sendCommand('Network.getAllCookies'))
        .cookies as Array<Record<string, unknown>>
    }
    const loggedIn = async (site: string) => {
      await agent.load(site, 10000)
      return (
        (await agent.view.webContents.executeJavaScript(
          'document.getElementById("logged").textContent',
        )) === 'true'
      )
    }
    const file = join(profile, 'browser', 'session-cookies.enc')
    if (stage === 'seed' || stage === 'crash') {
      step = '两个站点登录'
      for (const site of sites) assert.equal((await user.load(`${site}/login`, 10000)).ok, true)
      for (const site of sites) assert.equal(await loggedIn(site), true)
      step = '读取分区'
      await snapshot()
      // 分区 Cookie 的登录态不能还原成不分区的跨站凭据。
      await agent.view.webContents.debugger.sendCommand('Network.setCookies', {
        cookies: [
          {
            name: 'partition-login',
            value: 'synthetic-partition',
            url: 'https://cookie.example/',
            secure: true,
            httpOnly: true,
            sameSite: 'None',
            partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true },
          },
        ],
      })
      step = '其他分区隔离'
      await session.defaultSession.cookies.set({
        url: sites[0],
        name: 'other-partition',
        value: 'synthetic-outside',
      })
      browser.settings.forgetSite()
      for (const site of sites) assert.equal(await loggedIn(site), true, '忘记站点权限不清登录')
      step = '持久化'
      await browser.flushData()
      const encrypted = readFileSync(file, 'utf8')
      assert.equal(encrypted.includes('synthetic'), false)
      const saved = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
      step = '密文内容核对'
      assert.equal(saved.cookies.length, 3)
      assert.ok(saved.cookies.every((cookie: { session: boolean }) => cookie.session))
    } else if (stage === 'read') {
      for (const site of sites)
        assert.equal(await loggedIn(site), true, '首次请求即带上恢复的登录态')
      const all = await snapshot()
      assert.equal(all.filter((cookie) => cookie.name === 'login-session').length, 2)
      assert.ok(
        all
          .filter((cookie) => cookie.name === 'login-session')
          .every((cookie) => cookie.session === true && cookie.httpOnly === true),
      )
      assert.equal(all.filter((cookie) => cookie.name === 'login-persistent').length, 2)
      assert.equal(
        all.some((cookie) => cookie.name === 'other-partition'),
        false,
      )
      const partitioned = all.find((cookie) => cookie.name === 'partition-login')
      assert.deepEqual(partitioned?.partitionKey, {
        topLevelSite: 'https://top.example',
        hasCrossSiteAncestor: true,
      })
    } else if (stage === 'logout') {
      for (const site of sites) await user.load(`${site}/logout`, 10000)
      await browser.flushData()
    } else if (stage === 'read-logout') {
      for (const site of sites) assert.equal(await loggedIn(site), false)
      assert.equal((await cookies.get({ name: 'login-persistent' })).length, 2)
    } else if (stage === 'clear') {
      await browser.settings.clearData()
      assert.equal((await snapshot()).length, 0)
    } else if (stage === 'read-clear') {
      for (const site of sites) assert.equal(await loggedIn(site), false)
      assert.equal((await snapshot()).length, 0)
    } else throw new Error('未知验收阶段')
    await browser.flushData()
    console.log(`LITCH_COOKIE_STATE ${JSON.stringify({ stage, ok: true })}`)
    if (stage === 'crash') process.kill(process.pid, 'SIGKILL')
    else {
      browser.host.close(user.id)
      browser.host.close(agent.id)
      server.close()
      app.quit()
    }
  })
  .catch((error: unknown) => {
    // 底层异常可能带测试 Cookie；也不让验收输出形成泄露值的惯例。
    console.log(
      `LITCH_COOKIE_STATE ${JSON.stringify({ step, ok: false, kind: error instanceof Error ? error.name : 'unknown', at: error instanceof Error ? error.stack?.split('\n')[1] : '' })}`,
    )
    app.exit(1)
  })
