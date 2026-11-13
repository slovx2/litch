// 隐藏 Electron 窗口中的正式组件；核心使用模拟数据，系统操作与剪贴板为隔离替身。
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function checkMediaMenu({ window, read, wait, output, downloaded }) {
  const local = '.transcript-image-open:has(img[alt="相对图片"])'
  const remote = '.transcript-image-open:has(img[alt="远程图片"])'
  const web = '.transcript-image-open:has(img[alt="外网图片"])'
  const tool = '#tool-fixture .tool-image-open'
  const key = async (keyCode) => {
    if (keyCode === 'Return') {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      })
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
    } else {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    await read('new Promise(r => requestAnimationFrame(r))')
  }
  const click = async (selector, button = 'left') => {
    const point = await read(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`,
    )
    for (const type of ['mouseDown', 'mouseUp'])
      window.webContents.sendInputEvent({ type, ...point, button, clickCount: 1 })
  }
  const ids = () =>
    read('Array.from(document.querySelectorAll("[role=menuitem]")).map(e=>e.dataset.action)')
  const open = async (selector) => {
    await click(selector, 'right')
    await wait('!!document.querySelector("[role=menu]")')
    assert.equal(await read('document.activeElement?.getAttribute("role")'), 'menuitem')
  }
  const pick = async (id) => {
    await click(`[role=menuitem][data-action=${id}]`)
    await wait('!document.querySelector("[role=menu]")')
  }
  const checkList = async (selector, expected) => {
    await open(selector)
    assert.deepEqual(await ids(), expected)
    assert.equal(await read('!!document.querySelector("[role=menuitem]:disabled")'), false)
  }
  await wait('document.querySelectorAll("[data-media-state=ready]").length === 5')
  await wait('!!document.querySelector("#tool-fixture .tool-image-open")')
  await checkList(local, ['copy', 'revealLocal', 'copyPath', 'files', 'enlarge'])
  await key('Down')
  assert.equal(await read('document.activeElement.dataset.action'), 'revealLocal')
  await key('Up')
  assert.equal(await read('document.activeElement.dataset.action'), 'copy')
  await key('Escape')
  assert.equal(await read(`document.activeElement.matches(${JSON.stringify(local)})`), true)
  await open(local)
  await key('Return')
  await wait('window.mediaFixture.effects.png.length === 1')
  assert.ok(await read('window.mediaFixture.effects.png[0] > 0'))
  await open(local)
  await pick('copyPath')
  await wait('window.mediaFixture.effects.paths[0] === "/work/media-p1/photo.png"')
  await open(local)
  await pick('revealLocal')
  await wait('window.mediaFixture.effects.reveal.length === 1')
  assert.deepEqual(await read('window.mediaFixture.effects.reveal[0]'), {
    deviceId: 'local',
    root: '/work/media-p1',
    path: '/work/media-p1/photo.png',
  })
  await read('window.mediaFixture.effects.failReveal = true')
  await open(local)
  await pick('revealLocal')
  await wait('document.body.innerText.includes("文件或目录已不存在")')
  await read(
    'window.mediaFixture.effects.failReveal = false; window.mediaFixture.effects.failCopy = true',
  )
  await open(local)
  await pick('copy')
  await wait('document.body.innerText.includes("无法写入剪贴板")')
  await read(
    'window.mediaFixture.effects.failCopy = false; document.querySelectorAll(".toast-x").forEach(button => button.click())',
  )
  await open(local)
  await pick('files')
  await wait('window.mediaFixture.fileState().active?.endsWith("photo.png")')
  await checkList(remote, ['copy', 'save', 'copyPath', 'files', 'enlarge'])
  await pick('save')
  await wait('window.mediaFixture.effects.save.length === 1')
  const saved = await read('window.mediaFixture.effects.save[0]')
  assert.equal(saved.deviceId, 'build')
  assert.equal(saved.root, '/srv/work/media-p1')
  assert.equal(saved.path, '/srv/work/media-p1/photo.png')
  await checkList(web, ['copy', 'save', 'copyPath', 'enlarge', 'browser'])
  await pick('copyPath')
  await wait(
    'window.mediaFixture.effects.paths.includes("https://media-p1.example.invalid/photo.png")',
  )
  await open(web)
  await pick('browser')
  await wait('window.mediaFixture.effects.browser.length === 1')
  assert.deepEqual(await read('window.mediaFixture.effects.browser[0]'), {
    owner: { deviceId: 'build', threadId: 'atlas-session' },
    url: 'https://media-p1.example.invalid/photo.png',
  })
  await read('window.mediaFixture.setLinksInBrowser(false)')
  await open(web)
  await pick('browser')
  await wait('window.mediaFixture.effects.system.length === 1')
  await open(web)
  await pick('save')
  const deadline = Date.now() + 10000
  while (!downloaded() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(downloaded() && existsSync(join(output, 'saved-image.png')))
  await checkList(tool, ['copy', 'save', 'enlarge'])
  await pick('copy')
  await wait('window.mediaFixture.effects.png.length === 2')
  assert.ok(
    await read(
      'window.mediaFixture.calls.some(c => c.name === "media.image" && c.params.source.startsWith("litch-tool-image:"))',
    ),
  )
  await open(tool)
  await pick('save')
  const toolDeadline = Date.now() + 10000
  while (downloaded() < 2 && Date.now() < toolDeadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(downloaded(), 2, '工具原图完成下载后才释放 Blob')
  await open(tool)
  await pick('enlarge')
  await wait('document.querySelector(".tool-image-dialog[open] img")?.complete')
  await checkList('.tool-image-stage img', ['copy', 'save'])
  writeFileSync(
    join(output, 'tool-lightbox-menu.png'),
    (await window.webContents.capturePage()).toPNG(),
  )
  await key('Escape')
  assert.ok(await read('!!document.querySelector(".tool-image-dialog[open]")'))
  await key('Escape')
  await wait('!document.querySelector(".tool-image-dialog")')
  await open(local)
  await pick('enlarge')
  await wait('document.querySelector(".media-lightbox[open] img")?.complete')
  await checkList('.media-lightbox img', ['copy', 'revealLocal', 'copyPath', 'files'])
  writeFileSync(join(output, 'lightbox-menu.png'), (await window.webContents.capturePage()).toPNG())
  await key('Escape')
  assert.ok(await read('!!document.querySelector(".media-lightbox[open]")'))
  await read('window.mediaFixture.effects.failCopy = true')
  await open('.media-lightbox img')
  await pick('copy')
  await wait(
    'document.querySelector(".media-lightbox .toast")?.textContent.includes("无法写入剪贴板")',
  )
  await read('window.mediaFixture.effects.failCopy = false')
  await key('Escape')
  await wait('!document.querySelector(".media-lightbox")')
  await wait('document.querySelector(".toasts .toast")?.textContent.includes("无法写入剪贴板")')
  await read('document.querySelectorAll(".toast-x").forEach(button => button.click())')
  await open(local)
  await pick('enlarge')
  await wait('document.querySelector(".media-lightbox[open] img")?.complete')
  await open('.media-lightbox img')
  await pick('files')
  await wait('!document.querySelector(".media-lightbox")')
  for (const platform of ['darwin', 'win32', 'linux']) {
    await read(`window.litchShell.platform = '${platform}'`)
    await open(local)
    const titles = await read(
      'Array.from(document.querySelectorAll("[role=menuitem]")).map(e=>e.textContent)',
    )
    assert.ok(
      titles.includes(
        platform === 'darwin'
          ? '在 Finder 中打开'
          : platform === 'win32'
            ? '在资源管理器中显示'
            : '在文件管理器中打开',
      ),
    )
    await key('Escape')
  }
  await read('window.litchShell.platform = "darwin"')
  await read('document.querySelectorAll(".toast-x").forEach(button => button.click())')
  for (const skin of ['standard', 'retro', 'human'])
    for (const lang of ['zh-CN', 'en']) {
      await read(`window.__litchLook.set({skin:'${skin}',lang:'${lang}',theme:'light'})`)
      await read('document.fonts.ready')
      await open(local)
      await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      writeFileSync(
        join(output, `${skin}-${lang}.png`),
        (await window.webContents.capturePage()).toPNG(),
      )
      await key('Escape')
    }
  await read('document.querySelector("#toggle").click()')
  await wait('window.mediaFixture.urls.size === 0')
  assert.equal(window.isVisible(), false)
  assert.equal(window.isFocused(), false)
  writeFileSync(
    join(output, 'menu-result.json'),
    JSON.stringify(
      {
        passed: true,
        hidden: true,
        screenshots: 6,
        clipboard: '隔离PNG/文本剪贴板',
        destinations: '本机显示/远程保存/外网下载',
        tool: '按需原图',
        keyboard: true,
      },
      null,
      2,
    ),
  )
  console.log(
    '媒体菜单通过：本机/远程/外网/工具原图、两类灯箱、所有操作、错误提示、键盘、三平台文案、三皮肤中英截图',
  )
}
