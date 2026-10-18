// 动手前的实测：内置浏览器的 WebContentsView 在面板关着时，CDP 截图、输入还能不能用。
// 挂法逐种试：显示在窗口里、移出可视区（左、右）、setVisible(false)、不挂到任何窗口（一开始就不挂、挂过再摘下、
// 摘下后放一会儿）、摘下并关掉后台节流、摘下并用 CDP 指定视口。每种量：页面的可见状态、rAF 跑不跑、
// CDP 截图（并看按钮那一块的颜色对不对）、capturePage、鼠标点击、插入文字和按键。
//
// 这是一个独立的 Electron 主进程脚本，由 scripts/check-browser.mjs --v0 打包后起（窗口不显示）：
//   LITCH_V0_SHOWN=1 时窗口改成透明度 0、不接鼠标、不抢焦点地显示，用来对照“窗口在屏幕上”的情形。
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow, nativeImage, WebContentsView } from 'electron'

const shown = process.env.LITCH_V0_SHOWN === '1'
if (process.env.LITCH_PROFILE) app.setPath('userData', process.env.LITCH_PROFILE)

// 左上角一个按钮（点了改标题），下面一个输入框；按钮是深色的，截图里能认出来
const PAGE = `<!doctype html><title>t</title><style>body{margin:0;background:#fff}
#b{position:absolute;left:20px;top:20px;width:120px;height:40px;background:#123;border:0}
#i{position:absolute;left:20px;top:80px}</style>
<button id=b onclick="document.title='clicked'"></button><input id=i>`

type Result = Record<string, unknown>

const within = <T,>(work: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`超时：${label}`)), ms)),
  ])

async function measure(view: WebContentsView): Promise<Result> {
  const contents = view.webContents
  const cdp = contents.debugger
  if (!cdp.isAttached()) cdp.attach('1.3')
  const send = (method: string, params?: object) => cdp.sendCommand(method, params)
  const value = async (expression: string, awaitPromise = false) =>
    (
      (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })) as {
        result: { value: unknown }
      }
    ).result.value
  const out: Result = {}
  await value("document.title='t'; document.getElementById('i').value=''")
  out.visibility = await value('document.visibilityState')
  try {
    out.raf = await within(
      value('new Promise(r=>requestAnimationFrame(()=>r(true)))', true),
      2000,
      'rAF',
    )
  } catch (error) {
    out.raf = String((error as Error).message)
  }
  try {
    const shot = (await within(
      send('Page.captureScreenshot', { format: 'png' }),
      4000,
      '截图',
    )) as { data: string }
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
    const size = image.getSize()
    const bitmap = image.toBitmap()
    // 位图是 BGRA；按钮在 (60,40)，深色
    const at = (x: number, y: number) => {
      const offset = (y * size.width + x) * 4
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
    }
    const button = at(60, 40)
    out.cdpShot = {
      size,
      buttonDark: (button[0] ?? 255) < 80,
      blank: at(size.width - 5, size.height - 5),
    }
  } catch (error) {
    out.cdpShot = String((error as Error).message)
  }
  try {
    const image = await within(
      contents.capturePage(undefined, { stayHidden: true }),
      4000,
      'capturePage',
    )
    out.capturePage = image.isEmpty() ? '空的' : image.getSize()
  } catch (error) {
    out.capturePage = String((error as Error).message)
  }
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const click = async (x: number, y: number) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await within(
        send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }),
        3000,
        '鼠标',
      )
  }
  try {
    await click(60, 40)
    out.click = (await value('document.title')) === 'clicked'
  } catch (error) {
    out.click = String((error as Error).message)
  }
  try {
    await click(40, 90)
    await within(send('Input.insertText', { text: 'hi' }), 3000, '插入文字')
    const key = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }
    await within(
      send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'a', ...key }),
      3000,
      '按键',
    )
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    out.typed = await value("document.getElementById('i').value")
  } catch (error) {
    out.typed = String((error as Error).message)
  }
  return out
}

/**
 * 网页的对话框（alert、confirm、prompt）：视图带 disableDialogs，不会弹出系统的对话框；
 * 量的是开了 Page 域之后调试器还收不收得到“对话框要开了”，以及经 CDP 答复之后网页拿到的是什么
 */
async function dialogs(url: string): Promise<Result> {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, disableDialogs: true },
  })
  await view.webContents.loadURL(url)
  const cdp = view.webContents.debugger
  cdp.attach('1.3')
  const seen: unknown[] = []
  cdp.on('message', (_event, method, params) => {
    if (method !== 'Page.javascriptDialogOpening') return
    seen.push(params)
    void cdp
      .sendCommand('Page.handleJavaScriptDialog', { accept: true, promptText: 'ok' })
      .catch((error: unknown) => seen.push(String(error)))
  })
  await cdp.sendCommand('Page.enable')
  const run = async (expression: string) => {
    try {
      const reply = (await within(
        cdp.sendCommand('Runtime.evaluate', { expression, returnByValue: true }),
        3000,
        expression,
      )) as { result: { value: unknown } }
      return reply.result.value
    } catch (error) {
      return String((error as Error).message)
    }
  }
  const out = {
    alert: await run("alert('a'); 'returned'"),
    confirm: await run("confirm('c')"),
    prompt: await run("prompt('p', 'x')"),
    seen,
  }
  view.webContents.close()
  return out
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

void app.whenReady().then(async () => {
  app.dock?.hide()
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(PAGE)
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const window = new BrowserWindow({ width: 900, height: 600, show: false })
  if (shown) {
    window.setOpacity(0)
    window.setIgnoreMouseEvents(true)
    window.showInactive()
  }
  await window.loadURL('about:blank')
  const box = { x: 0, y: 0, width: 600, height: 400 }
  const attach = (view: WebContentsView, bounds = box) => {
    window.contentView.addChildView(view)
    view.setBounds(bounds)
  }
  const cases: Record<string, (view: WebContentsView) => void | Promise<void>> = {
    onscreen: (view) => attach(view),
    offLeft: (view) => attach(view, { ...box, x: -5000 }),
    offRight: (view) => attach(view, { ...box, x: 950 }),
    setVisibleFalse: (view) => {
      attach(view)
      view.setVisible(false)
    },
    neverAttached: (view) => view.setBounds(box),
    detached: async (view) => {
      attach(view)
      await pause(300)
      window.contentView.removeChildView(view)
    },
    detachedLong: async (view) => {
      attach(view)
      await pause(300)
      window.contentView.removeChildView(view)
      await pause(6000)
    },
    detachedNoThrottle: async (view) => {
      view.webContents.setBackgroundThrottling(false)
      attach(view)
      await pause(300)
      window.contentView.removeChildView(view)
      await pause(3000)
    },
    detachedMetrics: async (view) => {
      attach(view)
      await pause(300)
      window.contentView.removeChildView(view)
      view.webContents.debugger.attach('1.3')
      await view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 1024,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      })
    },
  }
  const results: Record<string, Result> = {}
  for (const [name, setup] of Object.entries(cases)) {
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await view.webContents.loadURL(url)
    await setup(view)
    await pause(500)
    results[name] = await measure(view).catch((error: unknown) => ({ error: String(error) }))
    if (window.contentView.children.includes(view)) window.contentView.removeChildView(view)
    view.webContents.close()
  }
  results.dialogs = await dialogs(url)
  console.log(`LITCH_V0 ${JSON.stringify({ shown, results })}`)
  server.close()
  app.exit(0)
})
