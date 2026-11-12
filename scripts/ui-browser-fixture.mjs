// 小型组件验收共用：隔离 CFT 和回环 Vite；也可连接已启动的手机网页预览。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

export async function browserFixture({ page, width = 1100, height = 940, evidence }, verify) {
  const work = mkdtempSync(join(tmpdir(), 'nebula-ui-'))
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
  assert.ok(binary)
  const external = /^https?:/.test(page)
  const vite = external
    ? null
    : await createServer({
        root: new URL('../packages/ui', import.meta.url).pathname,
        cacheDir: join(work, 'vite'),
        server: { host: '127.0.0.1', port: 0, hmr: false },
        logLevel: 'error',
      })
  let browser, cdp
  try {
    await vite?.listen()
    browser = spawn(
      binary,
      withChromiumTestArgs([
        '--headless=new',
        `--user-data-dir=${work}/profile`,
        '--remote-debugging-port=0',
        '--no-first-run',
        'about:blank',
      ]),
      {
        env: { PATH: process.env.PATH, HOME: work, TMPDIR: work },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    let log = ''
    browser.stderr.on('data', (chunk) => {
      log += chunk
    })
    cdp = await Cdp.connect(
      await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
    )
    const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    const call = (method, params) => cdp.call(method, params, sessionId)
    const read = async (expression) => {
      const r = await call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (r.exceptionDetails)
        throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    }
    const errors = []
    cdp.listeners.add((m) => {
      if (m.method === 'Runtime.exceptionThrown')
        errors.push(
          m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
        )
    })
    await call('Runtime.enable')
    await call('Page.enable')
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await call('Page.navigate', { url: external ? page : `${vite.resolvedUrls.local[0]}${page}` })
    const wait = (expression) =>
      until(() => read(expression), expression).catch(async (error) => {
        console.error(
          await read('({url:location.href,body:document.body.innerText.slice(0,2000)})'),
          errors,
        )
        throw error
      })
    const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const shot = async (name) => {
      if (!evidence) return
      await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      mkdirSync(evidence, { recursive: true })
      const r = await call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(evidence, name + '.png'), Buffer.from(r.data, 'base64'))
    }
    await verify({ read, call, wait, click, shot })
    assert.deepEqual(errors, [], '页面不应出现未处理异常')
  } finally {
    cdp?.close()
    if (browser && browser.exitCode === null) {
      const exited = new Promise((r) => browser.once('exit', r))
      browser.kill()
      await exited
    }
    await vite?.close()
    rmSync(work, { recursive: true, force: true })
  }
}
