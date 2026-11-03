// 隐藏窗口里的新标签回归：真实网页、Chromium 输入事件和正式浏览器宿主，不开调试端口。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow, type MouseInputEvent } from 'electron'
import { createElectronHost } from './browser/electron-host.mjs'
import type { HostTab } from './browser/electron-tab.mjs'
import { setHandedOver } from './browser/passwords/tabs.mjs'

if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const checks: { name: string; ok: boolean; detail?: unknown }[] = []
const check = (name: string, ok: boolean, detail?: unknown) =>
  checks.push({ name, ok, ...(ok ? {} : { detail }) })

void app.whenReady().then(async () => {
  app.dock?.hide()
  const limit = setTimeout(() => {
    console.log(`LITCH_BROWSER ${JSON.stringify({ ok: false, checks, error: '超时' })}`)
    app.exit(2)
  }, 60_000)
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><style>a,button{display:block;width:200px;height:40px}</style>
      <a id="link" href="/child" target="_blank">新标签</a>
      <button id="script" onclick="window.open('/child')">脚本新标签</button>
      <button id="timer" onclick="setTimeout(()=>window.open('/child'),0)">延迟弹窗</button>
      <iframe srcdoc="<body style='margin:0'><a style='display:block;height:100vh' href='${url}/child' target='_blank'>框架里的链接</a>"></iframe>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const window = new BrowserWindow({ width: 900, height: 600, show: false })
  const host = createElectronHost()
  const owner = { deviceId: 'local', threadId: 'popup-probe' }
  let selected = ''
  const shows: string[] = []
  const select = (tab: HostTab) => {
    selected = tab.id
    host.place(window, tab.id, { x: 0, y: 0, width: 800, height: 500 })
  }
  host.onShow((tab) => {
    shows.push(tab.id)
    select(host.page(tab.id) as HostTab)
  })
  const open = async (agent = false) => {
    const tab = host.open(owner, agent ? 'agent' : 'user') as HostTab
    tab.view.webContents.setBackgroundThrottling(false)
    await tab.load(url, 5000)
    select(tab)
    await tab.cdp('Runtime.evaluate', { expression: 'document.readyState' })
    await pause(100)
    return tab
  }
  const click = async (
    tab: HostTab,
    selector: string,
    button: MouseInputEvent['button'] = 'left',
    modifiers: string[] = [],
  ) => {
    const [x, y] = (await tab.view.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`,
    )) as [number, number]
    const flags = modifiers.reduce(
      (mask, mod) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 }[mod] ?? 0),
      0,
    )
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      // 验收代表人的输入，直接走调试器；登录交接的生产 CDP 闸仍然保持关闭。
      await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button,
        clickCount: 1,
        modifiers: flags,
      })
    }
  }
  const expectPopup = async (
    name: string,
    tab: HostTab,
    action: () => Promise<unknown>,
    foreground: boolean,
    kind: 'user' | 'agent' = 'user',
  ) => {
    const before = new Set(host.list().map((one) => one.id))
    const previous = selected
    const count = shows.length
    await action()
    const end = Date.now() + 3000
    while (host.list().length === before.size && Date.now() < end) await pause(20)
    await pause(150)
    const next = host.list().find((one) => !before.has(one.id))
    check(
      name,
      !!next &&
        next.kind === kind &&
        (foreground
          ? selected === next.id && shows.length === count + 1
          : selected === previous && shows.length === count),
      { next, selected, previous, shows },
    )
    if (next) host.close(next.id)
    select(tab)
  }
  try {
    await window.loadURL('about:blank')
    const tab = await open()
    await expectPopup('普通点击 target=_blank 切到新标签', tab, () => click(tab, '#link'), true)
    await expectPopup('点击 window.open 按钮切到新标签', tab, () => click(tab, '#script'), true)
    await expectPopup('子框架里的普通点击切到新标签', tab, () => click(tab, 'iframe'), true)
    await expectPopup(
      'Cmd/Ctrl 点击在后台打开',
      tab,
      () => click(tab, '#link', 'left', [process.platform === 'darwin' ? 'meta' : 'control']),
      false,
    )
    await expectPopup('中键点击在后台打开', tab, () => click(tab, '#link', 'middle'), false)
    await expectPopup(
      'Shift+中键点击在前台打开',
      tab,
      () => click(tab, '#link', 'middle', ['shift']),
      true,
    )
    await expectPopup(
      'Cmd/Ctrl+Shift 点击在前台打开',
      tab,
      () =>
        click(tab, '#link', 'left', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']),
      true,
    )
    await expectPopup(
      'Shift 点击在内置浏览器前台打开',
      tab,
      () => click(tab, '#link', 'left', ['shift']),
      true,
    )
    await expectPopup(
      '无用户手势的 window.open 不切换',
      tab,
      () => tab.view.webContents.executeJavaScript("window.open('/child');void 0"),
      false,
    )
    await expectPopup(
      '网页伪造点击不切换',
      tab,
      () => tab.view.webContents.executeJavaScript("document.querySelector('#link').click()"),
      false,
    )
    await expectPopup('点击后延迟弹窗不切换', tab, () => click(tab, '#timer'), false)
    await expectPopup(
      '键盘 Enter 打开新标签并切换',
      tab,
      async () => {
        await tab.view.webContents.executeJavaScript("document.querySelector('#link').focus()")
        for (const type of ['keyDown', 'keyUp'])
          await tab.cdp('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
      },
      true,
    )
    host.place(window, null, null)
    await expectPopup('面板收起时不因页面开窗而打开', tab, () => click(tab, '#script'), false)
    host.setNavigationGate(() => true)
    const agent = await open(true)
    agent.setAgentActive(true)
    select(tab)
    await expectPopup(
      '代理标签的弹窗继承代理归属、不切走用户标签',
      agent,
      () => click(agent, '#script'),
      false,
      'agent',
    )
    await expectPopup(
      '正在显示的代理标签也不因弹窗切换',
      agent,
      () => click(agent, '#script'),
      false,
      'agent',
    )
    setHandedOver(agent.view.webContents.id, true)
    select(agent)
    await expectPopup(
      '交给人登录时点击弹窗成为用户标签并切换',
      agent,
      () => click(agent, '#script'),
      true,
    )
    setHandedOver(agent.view.webContents.id, false)
    check('验收全程窗口隐藏', !window.isVisible())
  } catch (error) {
    check('没有意外出错', false, String(error instanceof Error ? error.stack : error))
  } finally {
    for (const tab of host.list()) host.close(tab.id)
    window.destroy()
    server.close()
    clearTimeout(limit)
  }
  const ok = checks.every((one) => one.ok)
  console.log(`LITCH_BROWSER ${JSON.stringify({ ok, pid: process.pid, checks })}`)
  app.exit(ok ? 0 : 1)
})
