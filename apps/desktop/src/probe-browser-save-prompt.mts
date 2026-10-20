// 浏览器面板上的保存提示（probe-browser-ui.mts 的一段）：眼前会话里的用户标签打开一个本机的登录页，
// 填好提交（POST 之后回一页“登进来了”），导航完成后面板上出“要保存……吗？”那一条；界面上没有密码；
// 点“保存”之后那一条没了、库里多了一条，来源是在内置浏览器里保存的。
// 登录页在回环上，自己起、自己关；safeStorage 在钥匙串里那一条按自检的应用名起名，check-browser.mjs 跑完删掉。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserWindow } from 'electron'
import type { HostTab } from './browser/electron-tab.mjs'
import type { InstalledBrowser } from './browser/install.mjs'

const LOGIN = `<!doctype html><title>Sign in</title>
<form method="post" action="/welcome"><input id="user" type="email" autocomplete="username">
<input id="pass" type="password"><button>Sign in</button></form>`

export async function checkSavePrompt(options: {
  window: BrowserWindow
  browser: InstalledBrowser
  tabId: string
  page(code: string): Promise<unknown>
  until(code: string, ms?: number): Promise<boolean>
  check(name: string, ok: boolean, detail?: unknown): void
  shot(name: string): Promise<void>
}): Promise<void> {
  const { browser, tabId, page, until, check, shot } = options
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
  try {
    const tab = browser.host.page(tabId) as HostTab | undefined
    if (!tab) {
      check('保存提示：有标签可用', false)
      return
    }
    await tab.load(`http://127.0.0.1:${port}/login`, 10_000)
    // 填好再提交（requestSubmit 发 submit 事件，预加载照样认）
    await tab.view.webContents.executeJavaScript(
      `user.value = 'probe@example.com'; pass.value = 'probe-pass-7'; document.forms[0].requestSubmit()`,
    )
    check(
      '保存提示：登录导航完成后面板上出提示',
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
    await page(`document.querySelector('.bw-save [data-act="save-password"]').click()`)
    check('保存提示：点了保存就没了', await until("!document.querySelector('.bw-save')"))
    const saved = browser.passwords.list().find((one) => one.username === 'probe@example.com')
    check(
      '保存提示：库里多了这一条，来源是在内置浏览器里保存的',
      saved?.origin === `http://127.0.0.1:${port}` && saved.source === 'litch',
      browser.passwords.list(),
    )
  } finally {
    server.close()
  }
}
