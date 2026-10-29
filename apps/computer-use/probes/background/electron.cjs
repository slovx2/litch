// 使用仓库现有 Electron 二进制，不安装依赖、不连接网络、不使用用户浏览器 profile。
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
const directory = arg('--directory')
if (!directory || !path.isAbsolute(directory)) throw new Error('需要绝对 --directory')
app.setPath('userData', path.join(directory, 'profile'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
fs.mkdirSync(directory, { recursive: true })
let latest = {},
  commandID = '',
  win,
  timer
function save() {
  if (!win || win.isDestroyed()) return
  const bounds = win.getContentBounds()
  const points = Object.fromEntries(
    Object.entries(latest.points ?? {}).map(([k, p]) => [
      k,
      { x: bounds.x + p.x, y: bounds.y + p.y },
    ]),
  )
  const data = {
    ...latest,
    points,
    frame: win.getBounds(),
    pid: process.pid,
    kind: 'electron',
    active: win.isFocused(),
    commandID,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    bundleId: 'com.github.Electron',
  }
  fs.writeFileSync(path.join(directory, 'state.tmp'), JSON.stringify(data))
  fs.renameSync(path.join(directory, 'state.tmp'), path.join(directory, 'state.json'))
}
app.whenReady().then(async () => {
  const reference = JSON.parse(
    fs.readFileSync(path.join(directory, '..', 'appkit', 'state.json'), 'utf8'),
  )
  win = new BrowserWindow({
    x: reference.frame.x,
    y: reference.frame.y,
    width: reference.frame.width,
    height: reference.frame.height,
    show: false,
    title: 'Litch M0 Electron — 仅测试内容',
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  ipcMain.on('fixture-state', (event, body) => {
    if (event.sender !== win.webContents) return
    latest = body
    save()
  })
  await win.loadFile(path.join(__dirname, 'fixture.html'))
  win.showInactive()
  timer = setInterval(() => {
    try {
      const command = JSON.parse(fs.readFileSync(path.join(directory, 'command.json'), 'utf8'))
      if (command.id !== commandID) {
        commandID = command.id
        if (command.action === 'activate') {
          win.show()
          win.focus()
        } else if (command.action === 'quit') {
          app.quit()
          return
        } else win.webContents.send('fixture-command', command.action)
      }
    } catch {}
    save()
  }, 50)
})
app.on('window-all-closed', () => {
  clearInterval(timer)
  app.quit()
})
