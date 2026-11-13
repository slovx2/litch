// 正式 Transcript + 协议夹具；只提供隔离缓存像素，不读取真实文件或个人会话。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const missing = process.argv.includes('--expect-missing')
const output = process.env.LITCH_IMAGE_FIRST_OUTPUT ?? '.artifacts/tool-image-first-open'
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'tool-first-'))
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
  const endpoint = await until(() => /DevTools listening on (ws:\S+)/.exec(stderr)?.[1], 'Chrome')
  cdp = await Cdp.connect(endpoint)
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
  const wait = (expression) => until(() => read(expression), expression)
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  for (const mode of ['completed', 'auto']) {
    await call('Page.navigate', {
      url: `${vite.resolvedUrls.local[0]}test/tool-image-first-open-fixture.html?mode=${mode}`,
    })
    await wait('!!document.querySelector(".tool-image-open")')
    if (mode === 'auto') {
      assert.equal(
        await read('!!document.querySelector(".proc-head[aria-expanded=false]")'),
        false,
        '运行中尚未自动折叠',
      )
      await read('window.toolImageFirstOpen.complete()')
    }
    await wait('!!document.querySelector(".proc-head[aria-expanded=false]")')
    assert.equal(await read('window.toolImageFirstOpen.requests.length'), 0, '缩略图不预读原图')
    await read(
      'document.querySelector(".proc-head").parentElement.querySelector(".tool-image-open").click()',
    )
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    assert.equal(
      await read('!!document.querySelector(".proc-head[aria-expanded=true]")'),
      true,
      '保留 touch 防自动折叠',
    )
    const opened = await read('!!document.querySelector(".tool-image-dialog[open]")')
    assert.equal(opened, !missing, `${mode} 首次点击${missing ? '复现丢失查看器' : '打开查看器'}`)
    if (!missing) {
      await wait('document.querySelector(".tool-image-dialog img")?.naturalWidth === 120')
      const requests = await read('window.toolImageFirstOpen.requests')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].source, 'litch-tool-image:' + 'a'.repeat(63) + '0')
    }
    writeFileSync(
      join(output, `${mode}-${missing ? 'before' : 'after'}.png`),
      Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    )
    if (!missing) {
      await call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      })
      await call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      })
      await wait('!document.querySelector(".tool-image-dialog")')
      assert.equal(
        await read('document.querySelector(".proc-head").getAttribute("aria-expanded")'),
        'true',
      )
    }
    console.log(
      'PASS',
      mode,
      missing ? 'baseline reproduced' : 'first click, cached pixels, touch retained',
    )
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
