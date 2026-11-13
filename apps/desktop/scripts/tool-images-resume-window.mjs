import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', process.env.LITCH_IMAGE_PROFILE)
app.dock?.hide()
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: { backgroundThrottling: false },
  })
  const read = (expression) => window.webContents.executeJavaScript(expression, true)
  const wait = async (expression) => {
    const end = Date.now() + 30000
    while (!(await read(expression))) {
      if (Date.now() > end) throw new Error(`超时：${expression}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  try {
    await window.loadURL(process.env.LITCH_IMAGE_URL)
    const ready = 'document.querySelector(".tool-image-open img")?.naturalWidth > 0'
    await wait(ready)
    await window.loadURL(process.env.LITCH_IMAGE_URL)
    await wait(ready)
    await read('window.__litchLook.set({skin:"standard",theme:"light"})')
    await read('document.fonts.ready')
    await read(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )
    writeFileSync(
      join(process.env.LITCH_IMAGE_OUTPUT, 'reopened.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    // 原图验收从已展开的过程组进入，首屏截图仍保留默认折叠状态。
    await read('document.querySelector(".proc-head").click()')
    await wait(
      'document.querySelector(".proc-head")?.getAttribute("aria-expanded") === "true" && document.querySelector(".tool-image-open img")?.naturalWidth > 0',
    )
    await read('document.querySelector(".tool-image-open").click()')
    await wait('document.querySelector(".tool-image-dialog img")?.naturalWidth === 320')
    assert.equal(await read('document.querySelector(".tool-image-dialog img").naturalHeight'), 200)
    writeFileSync(
      join(process.env.LITCH_IMAGE_OUTPUT, 'reopened-image.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    console.log('PASS：真实设备、正式核心和对话组件，重开首屏缩略图与原图可见')
  } catch (error) {
    console.error(error)
    console.error(await read('document.querySelector(".tool-image-dialog")?.outerHTML'))
    writeFileSync(
      join(process.env.LITCH_IMAGE_OUTPUT, 'failed.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    process.exitCode = 1
  } finally {
    window.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
