// 只由 settings.mjs 在隔离 HOME 中启动；隐藏窗口内点击正式组件，状态从通道夹具返回。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { app, BrowserWindow } = require('electron')
const origin = process.env.LITCH_SETTINGS_URL
if (!origin || !process.env.HOME?.includes('litch-chrome-settings-'))
  throw new Error('Requires isolated launcher')
app.setPath('userData', join(process.env.HOME, 'profile'))
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('devtools:'),
    })
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const errors = []
  window.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('Content Security Policy')) errors.push(message)
  })
  const run = (source) => window.webContents.executeJavaScript(source)
  const wait = async (source, label, timeout = 7000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await run(`Boolean(${source})`)) return
      await delay(50)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const check = async (source, label) => assert.ok(await run(source), label)
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const status = (text) =>
    wait(
      `document.querySelector('[data-chrome-state]')?.textContent.includes(${JSON.stringify(text)})`,
      text,
    )
  const button = (text) =>
    run(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    )
  const load = async (state = 'fresh', platform = 'darwin', lang = 'zh-CN', store = true) => {
    await window.loadURL(
      `${origin}/test/fixtures/chrome/index.html?state=${state}&platform=${platform}&store=${store ? 1 : 0}`,
    )
    await wait('window.__litchLook && window.__chromeFixture', 'fixture ready')
    await run(`window.__litchLook.set({lang:${JSON.stringify(lang)}})`)
    await wait("document.querySelector('#chrome-enable')?.disabled === false", 'initial status')
  }
  const instance = {
    id: 'test',
    epoch: 'test',
    name: 'Chrome',
    version: '0.25.0',
    protocol: 1,
    incompatible: null,
    source: 'store',
  }
  let passed = 0
  const scenario = async (name, body) => {
    await body()
    passed++
    console.log(`PASS ${name}`)
  }
  try {
    await scenario('商店安装、等待与自动连接，保持控制开关关闭', async () => {
      await load()
      await status('尚未设置')
      await check(
        "!document.querySelector('[data-chrome-unpacked]').open",
        'manual starts collapsed',
      )
      await check(
        "document.querySelector('[data-chrome-store]').textContent.includes('从 Chrome 应用商店安装')",
        'primary button',
      )
      await click('[data-chrome-store]')
      await status('等待扩展连接')
      await check(
        "document.querySelector('#chrome-enable').getAttribute('aria-checked') === 'false'",
        'permission unchanged',
      )
      await check("window.__chromeFixture.calls.includes('chrome.store')", 'store request')
      await run(`window.__chromeFixture.patch({instances:[${JSON.stringify(instance)}]})`)
      await status('扩展已连接')
      await check(
        "document.querySelector('[data-chrome-store]').textContent.includes('在 Chrome 应用商店中打开')",
        'connected action',
      )
    })
    await scenario('返回窗口立即刷新断线状态', async () => {
      await run(
        "window.__chromeFixture.patch({instances:[]});window.dispatchEvent(new Event('focus'))",
      )
      await wait("!!document.querySelector('[data-chrome-waiting]')", 'focus refresh', 1500)
    })
    await scenario('准备失败显示错误，重试恢复', async () => {
      await load()
      await run('window.__chromeFixture.fail()')
      await click('[data-chrome-store]')
      await wait(
        "document.querySelector('[role=alert]')?.textContent.includes('connection setup failed')",
        'failure shown',
      )
      await status('尚未设置')
      await click('[data-chrome-store]')
      await status('等待扩展连接')
      await check("!document.querySelector('[role=alert]')", 'error cleared')
    })
    await scenario('旧状态回包不能覆盖安装结果', async () => {
      await load()
      await run("window.__chromeFixture.holdStatus();window.dispatchEvent(new Event('focus'))")
      await click('[data-chrome-store]')
      await status('等待扩展连接')
      await run('window.__chromeFixture.releaseStatus()')
      await delay(100)
      await check("!!document.querySelector('[data-chrome-waiting]')", 'stale status ignored')
    })
    await scenario('手动备选展开、准备、目录与扩展页', async () => {
      await load()
      await click('[data-chrome-unpacked] summary')
      await button('准备扩展')
      await status('等待扩展连接')
      await button('打开扩展目录')
      await button('打开扩展页')
      await check(
        "['chrome.prepare','chrome.directory','chrome.extensions'].every(k => window.__chromeFixture.calls.includes(k))",
        'manual requests',
      )
    })
    for (const [state, store, text] of [
      ['mismatch', true, '等待 Chrome 自动更新'],
      ['mismatch', false, '请在扩展页重新加载'],
      ['litch-outdated', true, '请升级 Litch'],
      ['reload', false, '重新加载即可更新'],
    ]) {
      await scenario(`兼容状态 ${state} store=${store}`, async () => {
        await load(state, 'darwin', 'zh-CN', store)
        await wait(
          `document.querySelector('[data-chrome-settings]').textContent.includes(${JSON.stringify(text)})`,
          text,
        )
      })
    }
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const lang of ['zh-CN', 'en']) {
        await scenario(`文案与布局 ${platform}/${lang}`, async () => {
          await load('fresh', platform, lang)
          await wait(
            `document.querySelector('[data-chrome-store]').textContent.includes(${JSON.stringify(lang === 'en' ? 'Install from Chrome Web Store' : '从 Chrome 应用商店安装')})`,
            'translation',
          )
          await check(
            `document.querySelector('[data-chrome-settings]').textContent.includes(${JSON.stringify(platform === 'linux' ? 'Chromium' : platform === 'win32' ? 'Edge' : 'Google Chrome')})`,
            'platform instructions',
          )
          for (const skin of ['retro', 'human', 'standard']) {
            await run(`window.__litchLook.set({skin:${JSON.stringify(skin)}})`)
            for (const width of [1000, 480]) {
              window.setSize(width, 1200)
              await delay(50)
              await check(
                "document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.set-body').scrollWidth <= document.querySelector('.set-body').clientWidth + 1",
                `${skin}/${width}: no overflow`,
              )
            }
          }
        })
      }
    }
    await scenario('站点权限仍独立生效', async () => {
      await load('connected')
      await wait("!!document.querySelector('[data-site]')", 'saved sites')
      await click('#set-trust-all-sites')
      await wait("window.__chromeFixture.calls.includes('chrome.trust')", 'trust request')
      await click('[data-site] button')
      await wait("window.__chromeFixture.calls.includes('chrome.forget')", 'forget request')
    })
    assert.equal(window.isVisible(), false, 'window stayed hidden')
    assert.deepEqual(errors, [], 'renderer errors')
    console.log(`Chrome settings: pass ${passed}, fail 0, skipped 0`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
