import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard } from 'electron'

app.setPath('userData', process.env.LITCH_MEDIA_PROFILE)
app.dock?.hide()
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1200,
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
  const output = process.env.LITCH_MEDIA_OUTPUT
  const forbidden = []
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const allowed =
      /^(blob:|data:)/.test(details.url) ||
      details.url.replace(/^ws:/, 'http:').startsWith(new URL(process.env.LITCH_MEDIA_URL).origin)
    if (!allowed) forbidden.push(details.url)
    done({ cancel: !allowed })
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, done) =>
    done(true),
  )
  let saved = false
  window.webContents.session.on('will-download', (_event, item) => {
    item.setSavePath(join(output, 'saved-image.png'))
    item.once('done', (_event, state) => {
      saved = state === 'completed'
    })
  })
  try {
    window.webContents.debugger.attach('1.3')
    await window.loadURL(process.env.LITCH_MEDIA_URL)
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    })
    await wait('document.querySelectorAll("[data-media-state=ready]").length === 5')
    await wait('document.querySelectorAll("[data-media-state=failed]").length >= 1')
    assert.equal(await read('document.querySelectorAll("[data-media-state=tooLarge]").length'), 1)
    assert.equal(
      await read(
        'window.mediaFixture.calls.some(c => /lazy|no-read|code/.test(c.params?.source ?? ""))',
      ),
      false,
    )
    assert.equal(
      await read(
        'window.mediaFixture.calls.some(c => c.params?.deviceId === "build" && c.params?.source === "/srv/work/media-p1/photo.png")',
      ),
      true,
    )
    assert.equal(
      await read(
        'Array.from(document.querySelectorAll(".transcript-image-open img")).every(i => i.clientHeight <= 360 && i.naturalWidth > 0)',
      ),
      true,
    )
    for (const skin of ['standard', 'retro', 'human']) {
      await read(`window.__litchLook.set({skin: '${skin}'})`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      writeFileSync(join(output, `${skin}.png`), (await window.webContents.capturePage()).toPNG())
    }
    await read('document.querySelector(".transcript-image-open").click()')
    await wait('document.querySelector(".media-lightbox[open] img")?.complete')
    const clickAt = async (x, y) => {
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await read(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
    }
    for (const skin of ['standard', 'retro', 'human'])
      for (const theme of ['light', 'dark']) {
        await read(`window.__litchLook.set({skin: '${skin}', theme: '${theme}'})`)
        await read('document.fonts.ready')
        await read(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        )
        const style = await read(`(() => {
        const dialog = document.querySelector('.media-lightbox')
        const rect = dialog.getBoundingClientRect()
        return { width: rect.width, height: rect.height, windowWidth: innerWidth, windowHeight: innerHeight,
          fill: getComputedStyle(dialog).backgroundColor, backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor }
      })()`)
        assert.equal(style.width, style.windowWidth)
        assert.equal(style.height, style.windowHeight)
        assert.equal(style.fill, 'rgba(0, 0, 0, 0)')
        assert.equal(style.backdrop, 'rgba(0, 0, 0, 0.8)')
        writeFileSync(
          join(output, `lightbox-${skin}-${theme}.png`),
          (await window.webContents.capturePage()).toPNG(),
        )
      }
    const center = await read(
      `(() => { const r = document.querySelector('.media-lightbox img').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`,
    )
    await clickAt(center.x, center.y)
    assert.equal(
      await read('!!document.querySelector(".media-lightbox[open]")'),
      true,
      '点图片不关',
    )
    // 空白处按下后拖动，松手不能当成点击遮罩。
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 20,
      y: 100,
      button: 'left',
      clickCount: 1,
    })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 60, y: 140 })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 60,
      y: 140,
      button: 'left',
      clickCount: 1,
    })
    await read('new Promise(resolve => requestAnimationFrame(resolve))')
    assert.equal(
      await read('!!document.querySelector(".media-lightbox[open]")'),
      true,
      '拖动松手不关',
    )
    await clickAt(20, 100)
    await wait('!document.querySelector(".media-lightbox")')
    await read('document.querySelector(".transcript-image-open").click()')
    await wait('document.querySelector(".media-lightbox[open] img")?.complete')
    const original = await read('document.querySelector(".media-lightbox img").clientWidth')
    await read('document.querySelector("[aria-label=放大]").click()')
    await wait(`document.querySelector('.media-lightbox img').clientWidth > ${original}`)
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 500,
      y: 500,
      button: 'left',
      clickCount: 1,
    })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 560, y: 530 })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 560,
      y: 530,
      button: 'left',
      clickCount: 1,
    })
    await wait(
      'document.querySelector(".media-lightbox img").style.transform !== "translate(0px, 0px)"',
    )
    for (let n = 0; n < 8; n++) await read('document.querySelector("[aria-label=放大]").click()')
    await wait('document.querySelector(".media-lightbox img").clientWidth > innerWidth')
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 500,
      y: 500,
      button: 'left',
      clickCount: 1,
    })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 650, y: 650 })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 650,
      y: 650,
      button: 'left',
      clickCount: 1,
    })
    await wait(
      'document.querySelector(".media-lightbox img").style.transform !== "translate(60px, 30px)"',
    )
    assert.equal(await read('!!document.querySelector(".media-lightbox[open]")'), true)
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 500,
      y: 500,
      button: 'left',
      clickCount: 2,
    })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 500,
      y: 500,
      button: 'left',
      clickCount: 2,
    })
    await wait(
      'document.querySelector(".media-lightbox img").style.transform === "translate(0px, 0px)"',
    )
    await read('document.querySelector("[aria-label=缩小]").click()')
    await read('document.querySelector("[aria-label=原始尺寸]").click()')
    await read(
      'Array.from(document.querySelectorAll(".media-lightbox-tools button")).find(b => b.textContent === "适应窗口").click()',
    )
    await wait(
      'document.querySelector(".media-lightbox img").style.transform === "translate(0px, 0px)"',
    )
    await read('document.querySelector("[aria-label=复制图片]").click()')
    const until = Date.now() + 10000
    while (!(await clipboard.has('image/png')) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(!(await clipboard.has('image/png')), false)
    await read('document.querySelector("[aria-label=保存图片]").click()')
    const saveUntil = Date.now() + 10000
    while (!saved && Date.now() < saveUntil)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert(saved && existsSync(join(output, 'saved-image.png')))
    await read('document.querySelector("[aria-label=下一张]").click()')
    await wait('document.querySelector(".media-lightbox-tools").textContent.includes("2 / 3")')
    writeFileSync(join(output, 'lightbox.png'), (await window.webContents.capturePage()).toPNG())
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await wait('!document.querySelector(".media-lightbox")')
    assert.equal(await read('document.activeElement.className'), 'transcript-image-open')
    await read('document.querySelector(".transcript-image-open").click()')
    await wait('document.querySelector(".media-lightbox[open] img")?.complete')
    await read('document.querySelector("[aria-label=在文件浏览器中显示]").click()')
    await wait('!document.querySelector(".media-lightbox")')
    assert.equal(await read('window.mediaFixture.fileState().active?.endsWith("photo.png")'), true)
    await read('document.querySelector("#toggle").click()')
    await wait('window.mediaFixture.urls.size === 0')
    assert.deepEqual(forbidden, [])
    assert.equal(window.isVisible(), false)
    assert.equal(window.isFocused(), false)
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify(
        { passed: true, hidden: true, forbidden, clipboard: 'PNG', saved, released: true },
        null,
        2,
      ),
    )
    console.log(
      '隐藏窗口媒体验收通过：本地/远程/外网夹具、根外、坏图、超限、懒加载、三皮肤、灯箱、复制、保存、释放',
    )
  } catch (error) {
    writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    console.error(error)
    process.exitCode = 1
  } finally {
    window.destroy()
    app.quit()
  }
})
