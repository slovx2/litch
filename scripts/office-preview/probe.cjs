// 专用 app:// 探针：不创建可见窗口，不加载 preload，不接受用户数据。
const { app, BrowserWindow, protocol, net } = require('electron')
const { readFileSync } = require('node:fs')
const { resolve, sep } = require('node:path')
const { pathToFileURL } = require('node:url')
app.setName('Litch Office Probe')
app.setPath('userData', process.env.LITCH_OFFICE_PROFILE)
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
const root = resolve(process.env.LITCH_OFFICE_ASSETS)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
app.whenReady().then(async () => {
  app.dock?.hide()
  const deadline = setTimeout(() => app.exit(2), 60_000)
  try {
    protocol.handle('app', (request) => {
      const url = new URL(request.url),
        path = resolve(root, `.${decodeURIComponent(url.pathname)}`)
      if (url.host !== 'ui' || !path.startsWith(root + sep))
        return new Response('', { status: 403 })
      return net.fetch(pathToFileURL(path).toString())
    })
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    const guard = setInterval(() => {
      if (window.isVisible() || window.isFocused()) app.exit(3)
    }, 50)
    const page = (expression) => window.webContents.executeJavaScript(expression)
    const until = async (expression) => {
      for (let i = 0; i < 300; i++) {
        const value = await page(expression)
        if (value) return value
        await pause(50)
      }
      throw Error(`等待失败：${expression}`)
    }
    await window.loadURL('app://ui/test/preview/index.html')
    await until('!!window.previewCheck')
    const payloads = JSON.parse(readFileSync(process.env.LITCH_OFFICE_PAYLOADS, 'utf8'))
    const checks = []
    for (const format of ['docx', 'xlsx']) {
      const path = `native.${format}`
      await page(
        `window.previewCheck.result(${JSON.stringify(path)},${JSON.stringify(payloads[format])});window.previewCheck.open(${JSON.stringify(path)})`,
      )
      await pause(100)
      const state = await until(
        `(()=>{const e=document.querySelector('[data-office="${format}"]');return e&&e.dataset.state!=='loading'?e.dataset.state:null})()`,
      )
      if (state !== 'ready') throw Error(`${format}: ${state}`)
      checks.push(`${format} app:// 生产构建预览`)
      if (format === 'docx') {
        const frame = window.webContents.mainFrame.frames.find((f) => f.url === 'about:srcdoc')
        if (!frame) throw Error('没有 opaque frame')
        const result = await frame.executeJavaScript(
          `(()=>{let blocked=false;try{void parent.document}catch{blocked=true}return {blocked,bridge:typeof window.litchShell,header:!!document.querySelector('header')}})()`,
        )
        if (!result.blocked || result.bridge !== 'undefined' || !result.header)
          throw Error(JSON.stringify(result))
        checks.push('DOCX app:// opaque origin，无父页访问/bridge')
      }
    }
    if (window.isVisible() || window.isFocused()) throw Error('窗口可见/焦点异常')
    clearInterval(guard)
    window.destroy()
    clearTimeout(deadline)
    console.log(JSON.stringify({ ok: true, checks, windows: BrowserWindow.getAllWindows().length }))
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  }
})
