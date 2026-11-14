import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { app, BrowserWindow } = require('electron')
if (!process.env.HOME?.includes('litch-settings-structure-')) throw new Error('必须隔离 HOME')
app.setPath('userData', join(process.env.HOME, 'profile'))
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const mobile = process.env.LITCH_SETTINGS_MOBILE_URL
  const origin = mobile ?? process.env.LITCH_SETTINGS_URL
  window.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('devtools:') }),
  )
  const run = (source) => window.webContents.executeJavaScript(source)
  const wait = async (source, name = source) => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if (await run(`Boolean(${source})`)) return
      await delay(40)
    }
    throw new Error(`未等到 ${name}: ${await run('document.body.innerText.slice(-1500)')}`)
  }
  const click = async (selector) => {
    await wait(`document.querySelector(${JSON.stringify(selector)})`)
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const visible = (selector) => wait(`document.querySelector(${JSON.stringify(selector)})`)
  const shot = async (name) => {
    await run('document.fonts.ready')
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    await delay(150)
    await writeFile(
      join(process.env.LITCH_SETTINGS_OUTPUT, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    )
  }
  const check = async (source, label) => assert.ok(await run(source), label)
  const device = async (id = 'local') => {
    await click(`.set-nav [data-settings-device="${id}"]`)
    await wait(`document.querySelector('[data-detail="${id}"]')`)
    if (id !== 'gpu') await wait("document.querySelector('[data-manage-state=ready]')")
  }
  const harness = async (id = 'claude-code') => {
    await click(`[data-harness-block="${id}"] [data-act="harness-settings"]`)
    await wait(`document.querySelector('[data-hc="${id}"] [data-runtime-settings]')`)
  }
  try {
    if (mobile) {
      window.setSize(390, 844)
      for (const lang of ['zh-CN', 'en']) {
        for (const skin of ['retro', 'human', 'standard']) {
          await window.loadURL(
            `${mobile}/?app=1&scene=settings&appearance=light&skin=${skin}&lang=${lang}`,
          )
          await visible('[data-testid="settings:device:local"]')
          await shot(`mobile-${lang}-${skin}-home`)
          await click('[data-testid="settings:device:local"]')
          await visible('[data-testid="device-detail"]')
          await shot(`mobile-${lang}-${skin}-device`)
          await visible('[data-testid="harness:claude-code:settings"]')
          await run(
            `document.querySelector('[data-testid="harness:claude-code:settings"]').scrollIntoView({block:'center'})`,
          )
          await shot(`mobile-${lang}-${skin}-device-list`)
          await click('[data-testid="harness:claude-code:settings"]')
          await visible('[data-testid="manage:claude-code"]')
          await shot(`mobile-${lang}-${skin}-harness`)
          await click('[data-testid="header:back"]')
          await visible('[data-testid="device-detail"]')
          await click('[data-testid="header:back"]')
          await visible('[data-testid="settings"]')
          await check('document.documentElement.scrollWidth <= innerWidth', '手机页面无横向溢出')
        }
      }
      console.log('PASS 手机设置直达设备、独立 harness、逐级返回；三皮肤中英文24张')
      app.exit(0)
      return
    }
    await window.loadURL(`${origin}/?lang=zh-CN`)
    await click('.sb-settings')
    await wait("document.querySelector('.set-page') && window.__litchLook")
    if (process.env.LITCH_SETTINGS_BEFORE === '1') {
      await shot('before-home')
      await click('.set-nav [data-page="devices"]')
      await wait("document.querySelector('.devp-list')")
      await shot('before-devices')
      await click('.devp-item[data-device="local"] .devp-row')
      await visible('[data-manage-state="ready"]')
      await shot('before-device')
      console.log('PASS 改版前截图')
    } else {
      await check(
        "document.querySelectorAll('[data-settings-device]').length === 4",
        '设备全部平铺',
      )
      await click('[data-act="settings-add-device"]')
      await visible('dialog.modal[open] input')
      await click('dialog.modal[open] .modal-foot button')
      await wait(
        "document.querySelectorAll('dialog[open]').length === 1",
        '关闭添加设备，保留设置窗口',
      )
      for (const lang of ['zh-CN', 'en']) {
        for (const skin of ['retro', 'human', 'standard']) {
          await run(`window.__litchLook.set(${JSON.stringify({ lang, skin, theme: 'light' })})`)
          await click('.set-nav [data-section="look"]')
          await shot(`${lang}-${skin}-home`)
          await device()
          await check(
            "document.querySelector('.set-device[aria-current=page]')?.dataset.settingsDevice === 'local'",
            '设备导航选中',
          )
          await check(
            "!document.querySelector('[data-sec=harnesses] .inst') && !document.querySelector('[data-sec=harnesses] [data-act=restart]')",
            '列表无安装和重启控件',
          )
          await shot(`${lang}-${skin}-device`)
          await harness()
          await check(
            "!!document.querySelector('[data-runtime-settings] [data-setting]')",
            '运行设置进入独立页',
          )
          await shot(`${lang}-${skin}-harness`)
          await click('[data-act="hc-back"]')
          await wait("document.querySelector('[data-detail=local]')")
        }
      }
      await device('build')
      await harness('codex')
      await click('.hc-tabs [data-tab="accounts"]')
      await wait("document.querySelector('[data-hc-tab=accounts]')")
      await shot('remote-codex-accounts')
      await run("import('/src/app/actions.ts').then(m=>m.requestDevice('local','harness:pi'))")
      await visible('[data-hc="pi"] [data-runtime-settings="pi"]')
      await click('[data-setting="harness.pi.enabled"] .switch')
      await visible('.mng-save')
      await click('.set-nav [data-settings-device="build"]')
      await visible('[data-leave-ask]')
      await click('[data-act="leave-cancel"]')
      await check("!!document.querySelector('[data-hc=pi]')", '取消切设备保留 harness 草稿')
      await click('.set-nav [data-settings-device="build"]')
      await click('[data-act="leave-discard"]')
      await visible('[data-detail="build"]')
      await click('.set-nav [data-section="look"]')
      await device('gpu')
      await check(
        "document.querySelector('[data-detail=gpu]')?.textContent.length > 0",
        '离线设备仍能进入',
      )
      window.setSize(900, 560)
      for (const page of ['home', 'device', 'harness']) {
        if (page === 'home') await click('.set-nav [data-section="look"]')
        if (page === 'device') await device()
        if (page === 'harness') await harness()
        await shot(`narrow-${page}`)
        await check(
          "[...document.querySelectorAll('.set-nav,.set-body,.arch-body')].every(e=>e.scrollWidth<=e.clientWidth+1)",
          `窄窗口 ${page} 无横向溢出`,
        )
      }
      console.log(
        'PASS 设备直达、添加、独立 harness、远程和离线设备、返回、三皮肤中英文18张、900×560布局',
      )
    }
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
  app.exit(0)
})
