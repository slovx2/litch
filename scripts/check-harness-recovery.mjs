// 正式设备列表定向验收：启动异常直接重启、忙中确认和取消；不连接真实设备。
// node scripts/check-harness-recovery.mjs [Expo 预览 URL] [截图目录]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const mobileUrl = process.argv[2]
const output = process.argv[3] ?? '.artifacts/harness-recovery'
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'litch-harness-ui-'))
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
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const shown = (selector) => read(`!!document.querySelector(${JSON.stringify(selector)})`)
  const shot = async (name) => {
    // RN Web 的模态框有入场动画，截图须等有限动画结束，不能把半透明的中间帧当最终布局。
    await read(
      `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
    )
    await read(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    )
    writeFileSync(
      join(output, `${name}.png`),
      Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    )
  }
  await call('Page.enable')
  await call('Runtime.enable')
  for (const platform of mobileUrl ? ['desktop', 'mobile'] : ['desktop']) {
    const mobile = platform === 'mobile'
    await call('Emulation.setDeviceMetricsOverride', {
      width: mobile ? 390 : 1100,
      height: mobile ? 844 : 760,
      deviceScaleFactor: 1,
      mobile,
    })
    const restart = (id) =>
      mobile
        ? `[data-testid="harness:${id}:restart"]`
        : `[data-harness-block="${id}"] [data-act="restart"]`
    const confirm = mobile ? '[data-testid="confirm:ok"]' : 'dialog[open] .confirm-yes'
    for (const device of ['local', 'build']) {
      const url = mobile
        ? new URL(mobileUrl)
        : new URL('test/harness-recovery-fixture.html', vite.resolvedUrls.local[0])
      url.search = new URLSearchParams({
        app: '1',
        scene: 'harness-recovery',
        device,
        lang: 'zh-CN',
        skin: 'standard',
        theme: 'light',
        appearance: 'light',
      }).toString()
      await call('Page.navigate', { url: url.href })
      await until(() => shown(restart('claude')), `${platform}/${device} 设备列表`, 60_000)
      for (const id of ['claude', 'codex', 'pi'])
        assert.ok(await shown(restart(id)), `${id} 有恢复入口`)
      assert.match(await read('document.body.textContent'), /context deadline exceeded/)
      if (device === 'local') await shot(`${platform}-list`)
      await click(restart('claude'))
      await until(() => shown(confirm), '忙中确认')
      assert.equal(await read('window.__harnessRecovery.calls.length'), 1)
      assert.ok(!(await read('window.__harnessRecovery.calls[0].params.force')))
      if (device === 'local') await shot(`${platform}-confirm`)
      if (mobile)
        await read(
          `Array.from(document.querySelectorAll('[role="button"]')).find(e => e.textContent === '取消').click()`,
        )
      else await click('dialog[open] .btn.ghost')
      await until(async () => !(await shown(confirm)), '取消关闭确认')
      assert.equal(await read('window.__harnessRecovery.calls.length'), 1, '取消不能重启')
      await click(restart('claude'))
      await until(() => shown(confirm), '再次确认')
      await click(confirm)
      await until(async () => !(await shown(restart('claude'))), '重启后可用，移除异常恢复入口')
      const calls = await read('window.__harnessRecovery.calls')
      assert.equal(calls.length, 3)
      assert.equal(calls[2].params.deviceId, device)
      assert.equal(calls[2].params.harness, 'claude')
      assert.equal(calls[2].params.force, true)
      await until(async () => !(await shown(confirm)), '确认框关闭')
      console.log(`PASS ${platform}/${device}: 三类异常入口、失败原因、忙中取消、force 确认与恢复`)
    }
  }
} finally {
  cdp?.close()
  if (browser?.exitCode === null) {
    const closed = new Promise((resolve) => browser.once('close', resolve))
    browser.kill()
    const force = setTimeout(() => browser.kill('SIGKILL'), 5000)
    await closed
    clearTimeout(force)
  }
  await vite.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
