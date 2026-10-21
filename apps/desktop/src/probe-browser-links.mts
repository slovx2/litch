// 浏览器面板自检（probe-browser-ui.mts）里“对话里的链接”那一段：真的界面、真的主进程那一半。
// 点回答里的网址 → 打开侧面板、换到浏览器标签、作为这个会话的用户标签新开一个；同一个网址再点切过去不再开；
// Cmd（别的系统 Ctrl）点、中键点 → 交给系统的浏览器；设置里关掉 → 交给系统的浏览器；
// 普通浏览器里的预览（另开一个不给 litchBrowser 的窗口）→ 不拦，让浏览器自己开新标签页。
// 页面里没有 litchShell（它在才会去连核心进程），“交给系统的浏览器”靠中途塞进去的一个只记网址的假 litchShell 看出来。
// 网址是模拟核心回答里的 https://example.com/a/b.ts：在浏览器的分区上接管 https，不出网。
import { BrowserWindow, net, session } from 'electron'
import { PARTITION } from './browser/electron-tab.mjs'
import type { InstalledBrowser } from './browser/install.mjs'

const LINK = 'https://example.com/a/b.ts'
const LINK_SEL = `a[href="${LINK}"]`
const SESSION_TITLE = '设备进程的转发开销基准'

export interface LinksProbe {
  window: BrowserWindow
  browser: InstalledBrowser
  uiUrl: string
  check(name: string, ok: boolean, detail?: unknown): void
  /** 给了截图目录时存一张 */
  shot(name: string): Promise<void>
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个窗口里的几样操作 */
function driver(window: BrowserWindow) {
  const page = (code: string) => window.webContents.executeJavaScript(code)
  const until = async (code: string, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await page(`!!(${code})`)) return true
      await pause(100)
    }
    return false
  }
  const row = `[...document.querySelectorAll('.ss-row')].find((r) => r.textContent.includes(${JSON.stringify(SESSION_TITLE)}))`
  return {
    page,
    until,
    /** 切到那个会话，发一句让模拟核心回带网址的那段话，等链接出来 */
    async sayFiles(): Promise<boolean> {
      if (!(await until(row))) return false
      await page(`${row}.click()`)
      if (!(await until("document.querySelector('textarea.cmp-text')"))) return false
      await page(`(async () => {
        const input = document.querySelector('textarea.cmp-text')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '看文件')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((done) => requestAnimationFrame(() => done()))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })()`)
      return until(`document.querySelector(${JSON.stringify(LINK_SEL)})`, 15_000)
    },
    /**
     * 在链接上点一下（init 给键和修饰键），回界面有没有把默认行为拦下来。
     * 窗口上最后再拦一道，免得没被界面拦下的那一下真去开窗口
     */
    click(init: { button?: number; metaKey?: boolean; ctrlKey?: boolean } = {}): Promise<boolean> {
      return page(`(() => {
        const init = ${JSON.stringify(init)}
        const type = init.button === 1 ? 'auxclick' : 'click'
        let prevented = null
        const last = (event) => {
          prevented = event.defaultPrevented
          event.preventDefault()
        }
        window.addEventListener(type, last, { once: true })
        const link = [...document.querySelectorAll(${JSON.stringify(LINK_SEL)})].at(-1)
        link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }))
        window.removeEventListener(type, last)
        return prevented
      })()`)
    },
    hideSide: () => page(`document.querySelector('.side button[data-tool="hide"]')?.click()`),
    row,
  }
}

export async function checkLinks({
  window,
  browser,
  uiUrl,
  check,
  shot,
}: LinksProbe): Promise<void> {
  const mac = process.platform === 'darwin'
  const partition = session.fromPartition(PARTITION)
  partition.protocol.handle('https', (request) =>
    request.url.startsWith('https://example.com/')
      ? new Response('<!doctype html><title>Example</title><p>ok</p>', {
          headers: { 'content-type': 'text/html' },
        })
      : net.fetch(request, { bypassCustomProtocolHandlers: true }),
  )
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    const ui = driver(window)
    const userTabs = () =>
      browser.host.list().filter((tab) => tab.kind === 'user' && tab.owner.threadId === 's4')

    check('链接：回答里有网址', await ui.sayFiles())
    await ui.hideSide()
    await pause(300)
    const before = userTabs().length
    check('链接：点了被界面接住', (await ui.click()) === true)
    check(
      '链接：打开面板、换到浏览器标签',
      await ui.until(
        `document.querySelector('.side:not([hidden]) .side-tab[data-tab="browser"][aria-selected="true"]') && document.querySelector('.side:not([hidden]) .bw-view')`,
      ),
    )
    const end = Date.now() + 8000
    while (Date.now() < end && !userTabs().some((tab) => tab.url === LINK)) await pause(100)
    const opened = userTabs()
    check(
      '链接：作为这个会话的用户标签新开一个',
      opened.length === before + 1 && opened.at(-1)?.url === LINK,
      opened,
    )
    check(
      '链接：新开的标签是眼前这个',
      await ui.until(
        `document.querySelector('.bw-tab[data-active="true"][data-kind="user"]')?.title.includes(${JSON.stringify(LINK)})`,
      ),
    )

    check('链接：同一个网址再点也被接住', (await ui.click()) === true)
    await pause(600)
    check('链接：同一个网址再点不再开', userTabs().length === before + 1, userTabs())

    // 设置里关掉（先关，再塞假的 litchShell：设置页的别处会去读它）
    await ui.page("document.querySelector('.sb-settings').click()")
    await ui.until("document.querySelector('.set-page')")
    await ui.page(`document.querySelector('.set-nav [data-section="browser"]')?.click()`)
    const toggle = 'document.querySelector(\'[data-act="links-in-browser"]\')'
    check('设置：开关默认开', await ui.until(`${toggle}?.getAttribute('aria-checked') === 'true'`))
    await pause(600)
    await shot('links-setting')
    await ui.page(`${toggle}.click()`)
    check(
      '设置：关掉记下来',
      (await ui.until(`${toggle}?.getAttribute('aria-checked') === 'false'`)) &&
        (await ui.page("localStorage.getItem('litch.browser')")) === '{"links":false}',
    )
    await ui.page(`${ui.row}.click()`)
    await ui.until(`document.querySelector(${JSON.stringify(LINK_SEL)})`)
    await ui.page(`window.__external = []
      window.litchShell = { platform: ${JSON.stringify(process.platform)}, openExternal: (url) => window.__external.push(url) }
      true`)
    const external = async () => (await ui.page('window.__external.length')) as number

    const count = userTabs().length
    check('设置关了：点了交给系统的浏览器', (await ui.click()) === true && (await external()) === 1)
    check('设置关了：不开标签', userTabs().length === count)

    // 打开回来，再看退路
    await ui.page("document.querySelector('.sb-settings').click()")
    await ui.until("document.querySelector('.set-page')")
    await ui.page(`document.querySelector('.set-nav [data-section="browser"]')?.click()`)
    await ui.until(`${toggle}`)
    await ui.page(`${toggle}.click()`)
    await ui.until(`${toggle}?.getAttribute('aria-checked') === 'true'`)
    await ui.page(`${ui.row}.click()`)
    await ui.until(`document.querySelector(${JSON.stringify(LINK_SEL)})`)
    check(
      `${mac ? 'Cmd' : 'Ctrl'} 点：交给系统的浏览器`,
      (await ui.click(mac ? { metaKey: true } : { ctrlKey: true })) === true &&
        (await external()) === 2 &&
        (await ui.page('window.__external[1]')) === LINK,
    )
    check(
      '中键点：交给系统的浏览器',
      (await ui.click({ button: 1 })) === true && (await external()) === 3,
    )
    await pause(300)
    check('修饰键、中键：不开标签', userTabs().length === count)

    // 普通浏览器里的预览：没有 litchBrowser，不拦，浏览器自己开
    const preview = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await preview.loadURL(uiUrl)
      const plain = driver(preview)
      check('预览：回答里有网址', await plain.sayFiles())
      await plain.hideSide()
      await pause(300)
      check('预览：点了不拦，交给浏览器自己开', (await plain.click()) === false)
      await pause(300)
      check('预览：面板不打开', await plain.page("!document.querySelector('.side:not([hidden])')"))
    } finally {
      preview.destroy()
    }
  } finally {
    partition.protocol.unhandle('https')
  }
}
