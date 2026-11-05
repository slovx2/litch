// 正式应用隐藏窗口，通过设备详情按钮和确认框重启夹具服务；不输出截图文件。
import assert from 'node:assert/strict'
import { app } from 'electron'

async function restart(upgrade: boolean): Promise<object> {
  const one = (selector: string) => document.querySelector<HTMLElement>(selector)
  const wait = async (selector: string) => {
    const end = Date.now() + 90000
    while (Date.now() < end) {
      const e = one(selector)
      if (e) return e
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw Error(`找不到 ${selector}: ${document.body.innerText.slice(-5000)}`)
  }
  ;(window as unknown as { __litchLook: { set(v: object): void } }).__litchLook.set({
    lang: 'zh-CN',
  })
  ;(await wait('.sb-settings')).click()
  ;(await wait('.set-go[data-page="devices"]')).click()
  ;(await wait('.devp-item[data-device="local"] .devp-row')).click()
  const section = await wait('[data-sec="service"]')
  if (section.dataset.open !== 'true') section.querySelector<HTMLButtonElement>('button')?.click()
  const before = (await wait('[data-fact="pid"]')).textContent
  const button = (await wait(
    upgrade ? '[data-act="service-force"]' : '[data-act="service-restart"]',
  )) as HTMLButtonElement
  if (upgrade && !one('[data-act="service-retry"]')) throw Error('本机没有同时提供立即重试')
  if (button.disabled) throw Error(`重启入口被禁用：${button.title}`)
  button.click()
  const dialog = await wait('dialog.confirm')
  const confirm = dialog.textContent
  const yes = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) =>
      (upgrade ? b.textContent?.includes('立即换上') : b.textContent?.includes('重启')) &&
      !b.textContent?.includes('取消'),
  )
  if (!yes) throw Error(`缺少二次确认按钮：${confirm}`)
  const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === '取消',
  )
  if (!cancel) throw Error('缺少取消入口')
  cancel.click()
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (one('[data-fact="pid"]')?.textContent !== before) throw Error('取消后仍重启了服务')
  button.click()
  const confirmed = await wait('dialog.confirm')
  const commit = [...confirmed.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === yes.textContent,
  )
  if (!commit) throw Error('第二次没有确认按钮')
  commit.click()
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const pid = one('[data-fact="pid"]')?.textContent
    if (pid && pid !== before) return { before, after: pid, confirm }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error(`重启后 PID 没变：${document.body.innerText.slice(-5000)}`)
}

let attached = false
app.on('browser-window-created', (_event, window) => {
  if (attached) return
  attached = true
  window.show = () => {}
  app.dock?.hide()
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const url = new URL(window.webContents.getURL())
      url.searchParams.set('onboarding', 'off')
      await window.loadURL(url.href)
      assert.equal(window.isVisible(), false)
      const result = await window.webContents.executeJavaScript(
        `(${restart.toString()})(${process.env.LITCH_RESTART_UPGRADE === 'true'})`,
        true,
      )
      console.log('隐藏窗口重启入口：', JSON.stringify(result))
      app.exit(0)
    })().catch((error: unknown) => {
      console.error(error)
      app.exit(1)
    })
  })
})
const main = process.env.LITCH_RESTART_MAIN
if (!main) throw Error('缺少隔离应用入口')
await import(main)
