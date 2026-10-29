// 专用隐藏窗口：所有 app:// 响应复用正式处理器及其 CSP。

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, protocol, session } from 'electron'
import { serveUiResource } from '../../apps/desktop/src/ui-protocol.mts'

const home = process.env.LITCH_OFFICE_HOME
if (!home) throw Error('仅允许隔离验收启动')
app.setPath('userData', join(home, 'profile'))
app.setPath('sessionData', join(home, 'session'))
app.disableHardwareAcceleration()
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
const record = (value) =>
  appendFileSync(process.env.LITCH_OFFICE_TRACE, `${JSON.stringify(value)}\n`)
void app.whenReady().then(async () => {
  app.dock?.hide()
  protocol.handle('app', async (request) => {
    const response = await serveUiResource(process.env.LITCH_OFFICE_ASSETS, request)
    record({ url: request.url, csp: response.headers.get('Content-Security-Policy') })
    return response
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const local =
      details.url.startsWith('app://ui/') ||
      details.url.startsWith(pathToFileURL(`${process.env.LITCH_OFFICE_ASSETS}/`).href)
    if (!local) record({ blockedRequest: details.url })
    callback({ cancel: !local })
  })
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', (event) => record({ console: event.message }))
  setInterval(() => {
    if (win.isVisible() || win.isFocused()) app.exit(3)
  }, 50)
  setTimeout(() => app.exit(2), 180_000)
  await win.loadURL('about:blank')
})
