// 消息收尾的无头浏览器验收。加 --scroll 复用滚动、收起和视图切换探针；不保存截图。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { checkMessageFooter } from './message-footer-checks.mjs'

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
assert.ok(binary?.includes('for Testing'))
const work = mkdtempSync(join(tmpdir(), 'litch-footer-ui-'))
const vite = await createServer({
  root: resolve('packages/ui'),
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
await vite.listen()
const base = vite.resolvedUrls.local[0]
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--window-size=1200,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex'), TMPDIR: work },
    stdio: 'ignore',
  },
)
let cdp
const errors = []
try {
  const port = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '调试端口',
  )
  const endpoint = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (tab) => tab.type === 'page',
      )?.webSocketDebuggerUrl,
    '自己的页面',
  )
  cdp = await Cdp.connect(endpoint)
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')
  cdp.listeners.add((event) => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text)
  })
  const evaluate = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    return result.result.value
  }
  await checkMessageFooter(cdp, evaluate, base)
  await cdp.call('Page.navigate', { url: `${base}?lang=zh-CN&onboarding=off` })
  await until(() => evaluate('document.querySelectorAll(".ss-row").length > 0'), '模拟会话')
  await evaluate(
    `[...document.querySelectorAll('.ss-row')].find(e=>e.textContent.includes('发版前的检查清单')).click()`,
  )
  await until(() => evaluate('!!document.querySelector(".turn-foot")'), '完成回合')
  if (process.argv.includes('--scroll')) {
    for (const name of ['scroll', 'fold', 'view', 'working']) {
      const module = await import(`../apps/desktop/src/probe-${name}.mts`)
      const probe = module[`${name}Probe`]
      await evaluate(
        `window.footerProbe = null; (${probe.toString()})().then(result => window.footerProbe={result}, error => window.footerProbe={error:String(error)}); void 0`,
      )
      const done = await until(() => evaluate('window.footerProbe'), `${name} 探针`, 180_000)
      assert.ok(!done.error, done.error)
      console.log(name, JSON.stringify(done.result))
      assert.deepEqual(module[`judge${name[0].toUpperCase()}${name.slice(1)}`](done.result), [])
    }
  }
  assert.deepEqual(errors, [])
} finally {
  cdp?.close()
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await stopped
  await vite.close()
  rmSync(work, { recursive: true, force: true })
}
