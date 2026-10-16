// 浏览器面板的自检（scripts/check-browser.mjs --ui，窗口不显示）：真的界面（packages/ui/dist，对着页面里的
// 模拟核心）、真的主进程那一半（installBrowser），量界面和外壳之间的那几件事：
// 打开浏览器标签、地址栏开网页、网页叠在 .bw-view 那块矩形上、收起面板就摘下来、浮层压上来时撤下、
// 代理的 show 打开面板、在标签上关掉。结果打一行 LITCH_BROWSER {ok, checks}；LITCH_BROWSER_SHOTS 给了目录时存几张截图。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol } from 'electron'
import type { HostTab } from './browser/electron-tab.mjs'
import { installBrowser } from './browser/install.mjs'
import { startPages } from './probe-browser-pages.mjs'

if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)
const uiRoot = normalize(process.env.LITCH_UI_ROOT ?? '')
const preload = process.env.LITCH_PROBE_PRELOAD ?? ''
const shots = process.env.LITCH_BROWSER_SHOTS

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

interface Check {
  name: string
  ok: boolean
  detail?: unknown
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(ok ? {} : { detail }) })
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

void app.whenReady().then(async () => {
  app.dock?.hide()
  const limit = setTimeout(() => {
    console.log(`LITCH_BROWSER ${JSON.stringify({ ok: false, checks, error: '超时' })}`)
    app.exit(1)
  }, 120_000)
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)
    const file = normalize(join(uiRoot, path === '/' ? 'index.html' : path))
    if (!file.startsWith(uiRoot + sep)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  const pages = await startPages()
  const browser = installBrowser({
    isUiUrl: (url) => url.startsWith('app://ui/'),
    userData: app.getPath('userData'),
  })
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const page = (code: string) => window.webContents.executeJavaScript(code)
  /** 等页面里一个条件成立；到点回 false */
  const until = async (code: string, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await page(`!!(${code})`)) return true
      await pause(100)
    }
    return false
  }
  const shot = async (name: string) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    const image = await window.webContents.capturePage()
    writeFileSync(join(shots, `${name}.png`), image.toPNG())
  }
  const viewOf = (id: string) => (browser.host.page(id) as HostTab | undefined)?.view
  const attached = () => {
    const view = viewOf(browser.host.list()[0]?.id ?? '')
    return !!view && window.contentView.children.includes(view)
  }

  try {
    await window.loadURL('app://ui/index.html?lang=zh-CN')
    check('界面起来了', await until("document.querySelector('.tb-side')", 15_000))
    await page("document.querySelector('.tb-side').click()")
    check('侧面板打开了', await until("document.querySelector('.side:not([hidden])')"))
    check(
      '标签栏里有“浏览器”',
      await page(
        "[...document.querySelectorAll('.side-tab')].some((b) => b.textContent.includes('浏览器'))",
      ),
    )
    await page(`document.querySelector('.side-tab[data-tab="browser"]').click()`)
    check(
      '浏览器标签装上了，没有网页时有说明',
      await until("document.querySelector('.bw-address') && document.querySelector('.bw-empty')"),
    )
    await shot('empty')

    // 地址栏里开一个网页
    await page(`(() => {
      const input = document.querySelector('.bw-address')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, ${JSON.stringify(`${pages.local}/form`)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.form.requestSubmit()
    })()`)
    check('开了一个用户的标签', await until("document.querySelectorAll('.bw-tab').length === 1"))
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !browser.host.list()[0]?.url.endsWith('/form')) await pause(100)
    const tab = browser.host.list()[0]
    check(
      '网页加载了、是用户的',
      tab?.kind === 'user' && tab.url.endsWith('/form') && tab.owner.threadId === '',
      tab,
    )
    check(
      '标签上显示网页标题',
      await until("document.querySelector('.bw-tab-name')?.textContent === 'Form'"),
    )
    await pause(300)
    check('网页叠在矩形上', attached())
    const rect = (await page(
      "(() => { const r = document.querySelector('.bw-view').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) })()",
    )) as number[]
    const bounds = viewOf(tab?.id ?? '')?.getBounds()
    check(
      '网页的位置大小和矩形一样',
      !!bounds &&
        Math.abs(bounds.x - (rect[0] ?? 0)) <= 1 &&
        Math.abs(bounds.y - (rect[1] ?? 0)) <= 1 &&
        Math.abs(bounds.width - (rect[2] ?? 0)) <= 1 &&
        Math.abs(bounds.height - (rect[3] ?? 0)) <= 1,
      { bounds, rect },
    )
    check(
      '地址栏跟着网页走',
      await until(
        `document.querySelector('.bw-address').value === ${JSON.stringify(`${pages.local}/form`)}`,
      ),
    )
    await shot('page')

    // 浮层压上来就撤下
    await page(
      `(() => { const m = document.createElement('div'); m.id = 'probe-menu'; m.setAttribute('role', 'menu'); const r = document.querySelector('.bw-view').getBoundingClientRect(); Object.assign(m.style, { position: 'fixed', left: r.left + 10 + 'px', top: r.top + 10 + 'px', width: '80px', height: '40px' }); document.body.append(m) })()`,
    )
    await pause(400)
    check('浮层压上来时网页撤下', !attached())
    await page("document.getElementById('probe-menu').remove()")
    await pause(400)
    check('浮层没了放回去', attached())

    // 收起面板就摘下来；代理 show 时打开
    await page(`document.querySelector('.side button[data-tool="hide"]').click()`)
    await pause(400)
    check('收起面板网页摘下来', !attached())
    browser.host.show(tab?.id ?? '')
    check('show 打开面板', await until("document.querySelector('.side:not([hidden]) .bw-view')"))
    await pause(400)
    check('show 之后网页又叠上去', attached())

    // 在标签上关掉
    await page(`document.querySelector('.bw-tab .ibtn').click()`)
    await pause(300)
    check(
      '关掉标签',
      browser.host.list().length === 0 &&
        (await until("document.querySelectorAll('.bw-tab').length === 0")),
    )

    // show 的是别的会话的网页：不把人从眼前拽走，侧栏那一行出记号、出提示，切过去才打开面板
    await page(`document.querySelector('.side button[data-tool="hide"]')?.click()`)
    await pause(300)
    const elsewhere = browser.host.open({ deviceId: 'local', threadId: 's4' }, 'agent', {
      keep: true,
    })
    browser.host.show(elsewhere.id)
    const rowOf =
      "[...document.querySelectorAll('.ss-row')].find((r) => r.textContent.includes('设备进程的转发开销基准'))"
    check('show 别的会话：侧栏那一行出记号', await until(`${rowOf}?.querySelector('.web-mark')`))
    check(
      'show 别的会话：出提示',
      await until(
        "document.querySelector('.toasts')?.textContent.includes('设备进程的转发开销基准')",
      ),
    )
    check(
      'show 别的会话：面板不打开',
      await page("!document.querySelector('.side:not([hidden]) .bw-view')"),
    )
    await page(`${rowOf}.click()`)
    check(
      '切到那个会话：打开面板、记号没了',
      (await until("document.querySelector('.side:not([hidden]) .bw-view')")) &&
        (await until(`!${rowOf}?.querySelector('.web-mark')`)),
    )
    await pause(400)
    check(
      '切到那个会话：网页叠上去',
      window.contentView.children.includes(viewOf(elsewhere.id) as never),
    )
    browser.host.close(elsewhere.id)
  } catch (error) {
    check('没有意外出错', false, error instanceof Error ? error.stack : String(error))
  }
  clearTimeout(limit)
  pages.close()
  const ok = checks.every((one) => one.ok)
  console.log(
    `LITCH_BROWSER ${JSON.stringify({ ok, passed: checks.filter((one) => one.ok).length, checks: checks.filter((one) => !one.ok) })}`,
  )
  app.exit(ok ? 0 : 1)
})
