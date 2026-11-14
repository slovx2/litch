// 定向 UI 验收：本机电源设置默认值、即时写入及中英文截图。只操作自己的模拟核心。
// node scripts/check-power-settings.mjs [截图目录]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const output = process.argv[2] ?? '.artifacts/power-settings'
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'litch-power-ui-'))
const vite = await createServer({
  root: new URL('../packages/ui', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
let browser, cdp
try {
  await vite.listen()
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
  assert.ok(binary, '缺少隔离验收用 Chromium')
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
    await until(() => /DevTools listening on (ws:\S+)/.exec(stderr)?.[1], 'Chromium'),
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
    if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const remoteKey = 'power.preventSleepWhileRemoteWorking'
  for (const lang of ['zh-CN', 'en']) {
    await call('Page.navigate', {
      url: `${vite.resolvedUrls.local[0]}test/power-settings-fixture.html?lang=${lang}&skin=standard&theme=light`,
    })
    await until(
      () => read(`document.querySelectorAll('[data-power-settings] [data-setting]').length === 3`),
      '三个电源开关',
    )
    const title = await read(
      `document.querySelector('[data-setting="${remoteKey}"] label').textContent`,
    )
    assert.equal(
      title,
      lang === 'zh-CN'
        ? '远程设备运行任务时也阻止本机休眠'
        : 'Prevent local sleep while remote tasks are running',
    )
    assert.equal(await read(`window.powerFixture.values()['${remoteKey}']`), false)
    writeFileSync(
      join(output, `settings-${lang}.png`),
      Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    )
    await read(`document.querySelector('[data-setting="${remoteKey}"] button').click()`)
    await until(
      () => read(`window.powerFixture.values()['${remoteKey}'] === true`),
      '远程开关即时保存',
    )
    assert.equal(await read(`window.powerFixture.values()['power.preventSleepWhileWorking']`), true)
    await read(`document.querySelector('[data-setting="${remoteKey}"] button').click()`)
    await until(
      () => read(`window.powerFixture.values()['${remoteKey}'] === false`),
      '远程开关关闭',
    )
    console.log(`PASS ${lang}: 默认关闭、独立即时写入、设置截图`)
  }
} finally {
  cdp?.close()
  if (browser?.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await exited
  }
  await vite.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
