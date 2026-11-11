import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
// 原生与推断阶段的无头浏览器验收：正式 Transcript + 模拟核心，截图留在 .artifacts/message-phase。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

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
const work = mkdtempSync(join(tmpdir(), 'litch-message-phase-'))
const artifacts = resolve('.artifacts/message-phase')
mkdirSync(artifacts, { recursive: true })
const vite = await createServer({
  root: resolve('packages/ui'),
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
await vite.listen()
const base = vite.resolvedUrls.local[0]
const child = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1200,900',
    'about:blank',
  ]),
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
  const read = () =>
    evaluate(`({
    text: document.body.innerText,
    groups: [...document.querySelectorAll('.steps-head')].map(e=>e.getAttribute('aria-expanded'))
  })`)
  for (const scenario of ['claude', 'codex', 'mixed']) {
    await cdp.call('Page.navigate', {
      url: `${base}test/message-phase-fixture.html?lang=zh-CN&scenario=${scenario}`,
    })
    await until(
      () => evaluate('!!window.phaseFixture && document.body.innerText.includes("检查完成")'),
      '运行中正文',
    )
    await evaluate('window.phaseFixture.finish()')
    await until(() => evaluate('!!document.querySelector(".proc-head")'), '完成后的过程摘要')
    const compact = await read()
    assert.equal(compact.text.includes('开始检查：'), scenario === 'claude')
    assert.equal(compact.text.includes('重要结论：'), scenario !== 'codex')
    assert.equal(compact.text.includes('检查完成。'), true)
    assert.deepEqual(compact.groups, scenario === 'codex' ? [] : ['false', 'false'])
    if (scenario !== 'codex')
      assert.ok(compact.text.indexOf('重要结论：') < compact.text.indexOf('检查完成。'))
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(artifacts, `${scenario}.png`), Buffer.from(shot.data, 'base64'))
    await evaluate('window.phaseFixture.verbose(true)')
    await until(() => evaluate('document.body.innerText.includes("工具输出 one")'), '详细视图')
    const verbose = await read()
    assert.ok(verbose.text.includes('开始检查：') && verbose.text.includes('重要结论：'))
    assert.deepEqual(verbose.groups, ['true', 'true'])
    await evaluate('window.phaseFixture.verbose(false)')
    await until(() => evaluate('!document.body.innerText.includes("工具输出 one")'), '恢复精简')
    assert.equal((await read()).text, compact.text)
    console.log(scenario, JSON.stringify(compact))
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
