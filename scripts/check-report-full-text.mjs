// 回报事件条与派出卡：用隔离无头窗口验证展开、完整正文和原回合定位。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
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
const work = mkdtempSync(join(tmpdir(), 'litch-report-ui-'))
const vite = await createServer({
  root: resolve('packages/ui'),
  server: { host: '127.0.0.1', port: 0 },
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
  await cdp.call('Page.navigate', { url: `${base}test/report-fixture.html` })
  await until(() => evaluate('!!document.querySelector(".compact-message")'), '回报组件')
  assert.equal(await evaluate('window.reportFixture.calls.length'), 0, '展开前不读取')
  await evaluate('document.querySelector(".compact-message").click()')
  await until(
    () => evaluate('document.querySelectorAll(".report-expand").length === 2'),
    '长回报各有一个展开入口',
  )
  assert.equal(
    await evaluate('document.querySelector("[data-child=short] .report-expand") === null'),
    true,
  )
  for (const selector of ['.sev-note[data-child=child]', '[data-card=spawn]']) {
    await evaluate(
      `document.querySelector(${JSON.stringify(`${selector} .report-expand`)}).click()`,
    )
    await until(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(`${selector} .report-body`)}).textContent === window.reportFixture.full`,
        ),
      '显示完整末尾与换行',
    )
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(`${selector} .report-text`)}).dataset.expanded`,
      ),
      'true',
    )
    await evaluate(
      `document.querySelector(${JSON.stringify(`${selector} .report-expand`)}).click()`,
    )
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(`${selector} .report-body`)}).textContent`,
      ),
      '摘录 [已截断]',
    )
  }
  const calls = await evaluate('window.reportFixture.calls')
  assert.equal(calls.length, 2)
  for (const call of calls)
    assert.deepEqual(call, {
      name: 'session.peek',
      params: { deviceId: 'device', sessionId: 'child', turnId: 'original' },
    })
  assert.deepEqual(errors, [])
  console.log('回报事件条、派出卡展开全文验收通过；短回答无入口；按原回合读取；收起恢复摘录。')
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  await vite.close()
}
