// 先 npm run client:build，再 node scripts/check-device-chrome-settings.mjs [截图目录]。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { removeTestTree } from './ci/remove-test-tree.mjs'

const binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  )
    .sort()
    .at(-1)
assert.ok(binary, '需要隔离 Chrome for Testing')
const output = process.argv[2] ?? '.artifacts/device-chrome-settings'
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'litch-device-chrome-ui-'))
let vite, browser, cdp
try {
  vite = await createServer({
    root: new URL('../packages/ui', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, hmr: false },
    logLevel: 'error',
  })
  await vite.listen()
  browser = spawn(
    binary,
    withChromiumTestArgs([
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      'about:blank',
    ]),
    {
      env: { PATH: process.env.PATH, HOME: profile, TMPDIR: profile },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let stderr = ''
  browser.stderr.on('data', (data) => {
    stderr += data
  })
  cdp = await Cdp.connect(
    await until(() => /DevTools listening on (ws:\S+)/.exec(stderr)?.[1], '隔离浏览器'),
  )
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const value = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  const section = '[data-sec="device-chrome"]'
  const panel = (name) => `${section} [data-chrome-panel="${name}"]`
  const one = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const has = (selector) => read(`Boolean(${one(selector)})`)
  const click = (selector) => read(`${one(selector)}.click()`)
  const connected = `${section}[data-condition="connected"]`
  const fold = `${section} button.fold`
  const disable = `${section} [data-act="device-chrome-disable"]`
  const copy = (name) => `${panel(name)} .device-chrome-command button`
  const more = 'window.deviceChromeFixture'
  const state = (name) => read(`${more}.set(${JSON.stringify(name)})`)
  const resize = (width) =>
    call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 840,
      deviceScaleFactor: 1,
      mobile: false,
    })
  const selectAppearance = async (skin, theme, lang) => {
    await read(`window.__litchLook.set(${JSON.stringify({ skin, theme, lang })})`)
    await until(
      () =>
        read(
          `window.__litchLook.get().skin === ${JSON.stringify(skin)} && document.documentElement.lang === ${JSON.stringify(lang)}`,
        ),
      '外观与语言',
    )
  }
  const open = async (state) => {
    await call('Page.navigate', {
      url: `${vite.resolvedUrls.local[0]}test/device-chrome-settings-fixture.html?state=${state}`,
    })
    await until(() => has(`${section}[data-condition="${state}"]`), `设备详情：${state}`)
  }
  const shot = async (name) => {
    const clip = await read(`(async () => {
      const section = ${one(section)}
      section.scrollIntoView({ block: 'center', behavior: 'instant' })
      await document.fonts.ready
      await new Promise(requestAnimationFrame)
      const { x, y, width, height } = section.getBoundingClientRect()
      if (y < 12 || y + height + 12 > innerHeight) throw new Error('设置节未完整进入截图范围')
      return { x: Math.floor(x) - 16, y: Math.floor(y) - 12, width: Math.ceil(width) + 32, height: Math.ceil(height) + 24, scale: 1 }
    })()`)
    const result = await call('Page.captureScreenshot', {
      format: 'png',
      clip,
      captureBeyondViewport: false,
    })
    writeFileSync(join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  await call('Page.enable')
  await resize(1050)
  await open('connected')
  assert.equal(await has(`${section} [data-chrome-panel]`), false, '打开已连接设备默认不显示命令')
  assert.equal(await read(`${one(fold)}.getAttribute('aria-expanded')`), 'false')
  assert.equal(await has(disable), true)
  await click(fold)
  await until(() => has(panel('setup')), '已连接时可展开设置步骤')
  assert.equal(await has(`${panel('setup')} code`), true)
  await click(disable)
  await until(() => has(panel('disable')), '显示停用命令')
  assert.equal(await has(panel('setup')), false, '停用时不摊开准备和安装')
  const commands = await read(`${more}.common`)
  assert.equal(
    await read(`${one(`${panel('disable')} code`)}.textContent`),
    commands.disableCommand,
  )
  await click(copy('disable'))
  await until(
    () => read(`${more}.copied === ${JSON.stringify(commands.disableCommand)}`),
    '复制停用命令',
  )
  await click(disable)
  await until(async () => !(await has(panel('disable'))), '关闭停用命令')

  await open('unprepared')
  await selectAppearance('standard', 'dark', 'zh-CN')
  assert.equal(await read(`document.querySelectorAll('${panel('setup')} ol > li').length`), 3)
  assert.equal(await has(disable), false)
  assert.equal(await read(`${one(`${panel('setup')} a`)}.href`), commands.storeUrl)
  await click(`${panel('setup')} a`)
  assert.equal(await read(`${more}.opened`), commands.storeUrl, '商店链接通过系统浏览器入口打开')
  for (const [nth, command] of [
    [1, commands.prepareCommand],
    [3, commands.enableCommand],
  ]) {
    const button = `${panel('setup')} li:nth-child(${nth}) .device-chrome-command button`
    await click(button)
    await until(() => has(`${button}[data-copied="true"]`), '复制图标变为成功')
    assert.equal(await read(`${more}.copied`), command)
    assert.equal(await read(`${one(button)}.getAttribute('aria-label')`), '已复制')
    await until(() => has(`${button}[data-copied="false"]`), '复制图标复原', 3500)
  }
  await read(`${more}.denyClipboard = true`)
  await click(copy('setup'))
  await until(() => has('[data-toast="device-chrome-copy"][role="alert"]'), '剪贴板失败显示提示')
  await click('[data-toast="device-chrome-copy"] button')
  await until(async () => !(await has('[data-toast="device-chrome-copy"]')), '关闭失败提示')
  await read(`${more}.denyClipboard = false`)

  await resize(540)
  const layout = await read(`(() => {
    const code = ${one(`${panel('setup')} code`)}
    const action = code.nextElementSibling
    return {
      codeOverflow: code.scrollWidth > code.clientWidth,
      wholeAction: action.getBoundingClientRect().right <= ${one(section)}.getBoundingClientRect().right,
      nowrap: getComputedStyle(code).whiteSpace,
    }
  })()`)
  assert.deepEqual(layout, { codeOverflow: true, wholeAction: true, nowrap: 'nowrap' })
  await resize(1050)
  await state('waiting')
  await until(
    () => has(`${section}[data-condition="waiting"] [data-chrome-panel="setup"]`),
    '等待时仍展示步骤',
  )
  // 模拟设备主动推送连接状态，不能要求用户离开页面再进来。
  await state('connected')
  await until(() => has(connected), '设备推送已连接')
  assert.equal(await has(`${section} [data-chrome-panel]`), false, '连接成功后立即收起')
  for (const [skin, theme, lang] of [
    ['standard', 'dark', 'zh-CN'],
    ['human', 'light', 'zh-CN'],
    ['retro', 'dark', 'zh-CN'],
    ['standard', 'light', 'en'],
  ]) {
    await selectAppearance(skin, theme, lang)
    await state('unprepared')
    await until(() => has(panel('setup')), '未连接默认打开步骤')
    assert.equal(await read(`${one(fold)}.textContent`), lang === 'en' ? 'Setup steps' : '设置步骤')
    assert.equal(
      await read(`(async () => {
        await document.fonts.ready
        const style = getComputedStyle(${one(`${panel('setup')} code`)})
        const ctx = document.createElement('canvas').getContext('2d')
        ctx.font = style.fontSize + ' ' + style.fontFamily
        return ctx.measureText('WWW').width === ctx.measureText('iii').width
      })()`),
      true,
      `${skin} 命令使用等宽字体`,
    )
    await shot(`${skin}-${lang}-unprepared`)
    await state('connected')
    await until(() => has(connected), '连接状态已更新')
    assert.equal(await has(`${section} [data-chrome-panel]`), false)
    assert.match(
      await read(`${one(connected)}.textContent`),
      lang === 'en' ? /Extension connected/ : /扩展已连接/,
    )
    await shot(`${skin}-${lang}-connected`)
  }
  console.log(
    `通过：已连接默认收起、状态变化自动收起、手动重开、停用命令、完整命令复制与商店链接、窄屏滚动。截图：${output}`,
  )
} finally {
  cdp?.close()
  if (browser?.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await exited
  }
  await vite?.close()
  removeTestTree(profile)
}
