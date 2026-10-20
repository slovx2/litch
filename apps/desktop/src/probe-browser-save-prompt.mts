// 浏览器面板上的保存提示（probe-browser-ui.mts 的一段）：眼前会话里的用户标签打开一个本机的登录页，
// 填好、真的点一下“登录”（受信任的输入事件；脚本 requestSubmit 的不算，也验一遍），POST 之后回一页“登进来了”，
// 导航完成后面板上出“要保存……吗？”那一条；界面上没有密码；密码库目录写不进去时点“保存”，提示留着、说原因；
// 能写了再点，那一条没了、库里多了一条，来源是在内置浏览器里保存的；钥匙串不可用的那种提示只说明、只能关掉。
// 再登录一次留一条提示，返回的 afterClose 在标签关掉之后核对提示跟着没了。
// 登录页在回环上，自己起、自己关；safeStorage 在钥匙串里那一条按自检的应用名起名，check-browser.mjs 跑完删掉。
import { chmodSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { HostTab } from './browser/electron-tab.mjs'
import type { InstalledBrowser } from './browser/install.mjs'
import { PASSWORDS_PROMPTS_CHANGED } from './browser/passwords/ipc.mjs'

const LOGIN = `<!doctype html><title>Sign in</title>
<form method="post" action="/welcome"><input id="user" type="email" autocomplete="username">
<input id="pass" type="password"><button id="go">Sign in</button></form>`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function checkSavePrompt(options: {
  window: BrowserWindow
  browser: InstalledBrowser
  tabId: string
  page(code: string): Promise<unknown>
  until(code: string, ms?: number): Promise<boolean>
  check(name: string, ok: boolean, detail?: unknown): void
  shot(name: string): Promise<void>
}): Promise<{ afterClose(): Promise<void> }> {
  const { window, browser, tabId, page, until, check, shot } = options
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        request.method === 'POST' ? '<!doctype html><title>Welcome</title><p>Signed in</p>' : LOGIN,
      )
    })
  })
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
  const nothing = { afterClose: async () => {} }
  const folder = join(app.getPath('userData'), 'browser')
  // 窗口藏着时合成的鼠标事件进不了网页：这一段起不抢焦点地显示出来，之后也不藏回去（藏回去之后页面算不可见，
  // requestAnimationFrame 不再跑，后面几段要等它）
  if (!window.isVisible()) window.showInactive()
  await sleep(300)
  try {
    const tab = browser.host.page(tabId) as HostTab | undefined
    if (!tab) {
      check('保存提示：有标签可用', false)
      return nothing
    }
    const contents = tab.view.webContents
    const login = async (username: string, password: string) => {
      await tab.load(`http://127.0.0.1:${port}/login`, 10_000)
      const [x, y] = (await contents.executeJavaScript(
        `user.value = ${JSON.stringify(username)}; pass.value = ${JSON.stringify(password)};
        (() => { const r = go.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`,
      )) as [number, number]
      // 不在前台的窗口偶尔吞掉一次点击：没跳页就再点一次
      for (let tries = 0; tries < 3 && contents.getURL().endsWith('/login'); tries++) {
        contents.sendInputEvent({ type: 'mouseMove', x: x - 1, y })
        contents.sendInputEvent({ type: 'mouseMove', x, y })
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        const end = Date.now() + 3000
        while (Date.now() < end && contents.getURL().endsWith('/login')) await sleep(100)
      }
    }

    // 脚本自己 requestSubmit（会导航）：不算登录提交，不出提示
    await tab.load(`http://127.0.0.1:${port}/login`, 10_000)
    await contents.executeJavaScript(
      `user.value = 'script@example.com'; pass.value = 'script-pass-1'; document.forms[0].requestSubmit()`,
    )
    await sleep(1500)
    check(
      '保存提示：脚本 requestSubmit 的不出提示',
      (await page("!document.querySelector('.bw-save')")) === true,
    )

    await login('probe@example.com', 'probe-pass-7')
    check(
      '保存提示：真的点了登录、导航完成后面板上出提示',
      await until(
        "document.querySelector('.bw-save')?.textContent.includes('probe@example.com')",
        10_000,
      ),
    )
    check(
      '保存提示：界面上没有密码',
      (await page("document.body.innerText.includes('probe-pass-7')")) === false,
    )
    await shot('save-prompt')

    // 密码库目录写不进去：点保存，提示留着、说没存上
    mkdirSync(folder, { recursive: true })
    chmodSync(folder, 0o500)
    try {
      await page(`document.querySelector('.bw-save [data-act="save-password"]').click()`)
      check(
        '保存提示：写不进去时提示留着、说原因',
        await until("!!document.querySelector('.bw-save [data-save-error]')"),
        await page("document.querySelector('.bw-save')?.outerHTML ?? null"),
      )
    } finally {
      chmodSync(folder, 0o700)
    }
    await page(`document.querySelector('.bw-save [data-act="save-password"]').click()`)
    check('保存提示：能写了再点保存就没了', await until("!document.querySelector('.bw-save')"))
    const saved = browser.passwords.list().find((one) => one.username === 'probe@example.com')
    check(
      '保存提示：库里多了这一条，来源是在内置浏览器里保存的',
      saved?.origin === `http://127.0.0.1:${port}` && saved.source === 'litch',
      browser.passwords.list(),
    )

    // 钥匙串不可用的那种（主进程推一条假的过来）：只说明、只有一个关掉的按钮
    const info = tab.info()
    window.webContents.send(PASSWORDS_PROMPTS_CHANGED, [
      {
        id: 'probe-unavailable',
        deviceId: info.owner.deviceId,
        threadId: info.owner.threadId,
        tabId: info.id,
        origin: `http://127.0.0.1:${port}`,
        username: 'nokey@example.com',
        kind: 'unavailable',
        at: Date.now(),
      },
    ])
    check(
      '保存提示：钥匙串不可用时说明存不了、只能关掉',
      (await until(
        "document.querySelector('.bw-save[data-save-prompt=\"unavailable\"]')?.textContent.includes('nokey@example.com')",
      )) &&
        (await page(
          `document.querySelectorAll('.bw-save button').length === 1 && !document.querySelector('.bw-save [data-act="save-password"]')`,
        )) === true,
      await page("document.querySelector('.bw-save')?.outerHTML ?? null"),
    )
    window.webContents.send(PASSWORDS_PROMPTS_CHANGED, [])

    // 再登录一次，留一条提示；标签关掉之后它跟着没了
    await login('later@example.com', 'later-pass-8')
    check(
      '保存提示：又登录一次又出一条',
      await until(
        "document.querySelector('.bw-save')?.textContent.includes('later@example.com')",
        10_000,
      ),
      {
        url: contents.getURL(),
        prompts: await page('window.litchBrowser.passwords.prompts()'),
        bar: await page("document.querySelector('.bw-save')?.outerHTML ?? null"),
      },
    )
    return {
      afterClose: async () => {
        const left = (await page('window.litchBrowser.passwords.prompts()')) as unknown[]
        check('保存提示：标签关掉之后提示跟着没了', left.length === 0, left)
      },
    }
  } finally {
    server.close()
  }
}
