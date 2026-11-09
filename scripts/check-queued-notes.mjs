// 两端正式回报组件 + 隔离通道：20 秒延迟应答下立即关闭，切页保留进度、失败与重试。
// --baseline <commit> 仅桌面：替换旧组件，在同一夹具量旧版等待确认的时长。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

import { mobileQueuedNotesFixture } from './queued-notes-mobile-fixture.mjs'

const mobile = process.argv.includes('--mobile')
const baselineIndex = process.argv.indexOf('--baseline')
const baseline = baselineIndex !== -1
const baselineRef = baseline ? process.argv[baselineIndex + 1] : null
if (baseline && !baselineRef) throw new Error('--baseline 需要基线提交号')
if (mobile && baseline) throw new Error('--baseline 仅支持桌面夹具')
const fixture = mobile ? await mobileQueuedNotesFixture() : null
const root = resolve(import.meta.dirname, '..')
const vite = mobile
  ? null
  : await createServer({
      root: join(root, 'packages/ui'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: baseline
        ? [
            {
              name: 'before-queued-notes',
              enforce: 'pre',
              load(id) {
                if (id === join(root, 'packages/ui/src/tree/EventBar.tsx'))
                  return execFileSync(
                    'git',
                    ['-C', root, 'show', `${baselineRef}:packages/ui/src/tree/EventBar.tsx`],
                    { encoding: 'utf8' },
                  )
              },
            },
          ]
        : [],
    })
await vite?.listen()
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
const state = mkdtempSync(join(tmpdir(), 'litch-queued-'))
const browser = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${state}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--window-size=900,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: state, CODEX_HOME: join(state, 'codex'), TMPDIR: state },
    stdio: 'ignore',
  },
)
let cdp
const errors = []
try {
  const port = await until(
    () => Number(readFileSync(join(state, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '端口',
  )
  const endpoint = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (tab) => tab.type === 'page',
      )?.webSocketDebuggerUrl,
    '页面',
  )
  cdp = await Cdp.connect(endpoint)
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')
  cdp.listeners.add((event) => {
    if (event.method === 'Runtime.exceptionThrown')
      errors.push(
        event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text,
      )
  })
  const read = async (expression) => {
    const value = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (value.exceptionDetails)
      throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  }
  const click = async (selector) => {
    await until(
      () =>
        read(
          `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      selector,
    )
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  if (mobile)
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
  await cdp.call('Page.navigate', {
    url: mobile
      ? `${fixture.url}/?app=1&lang=zh-CN&skin=standard`
      : `${vite.resolvedUrls.local[0]}test/queued-notes-fixture.html`,
  })
  await until(() => read('!!window.queuedFixture'), '夹具', 120000)
  if (mobile) await read('queuedFixture.open()')
  const chip = mobile ? '[data-testid="queued-notes:chip"]' : '.qn-chip'
  const panel = mobile ? '[data-testid="queued-notes:panel"]' : '.qn-pop'
  const deliver = mobile ? '[data-testid="queued-notes:deliver"]' : '.qn-deliver'
  await click(chip)
  await read(
    `window.clickAt = performance.now(); setTimeout(() => queuedFixture.${baseline ? 'ack' : 'fail'}(), 20000)`,
  )
  await click(deliver)
  await until(() => read(`!document.querySelector(${JSON.stringify(panel)})`), '浮窗收起', 25000)
  const closeMs = await read('performance.now() - clickAt')
  if (!baseline) {
    assert.match(
      await read(`document.querySelector(${JSON.stringify(chip)}).textContent`),
      /正在处理/,
    )
    assert.equal(await read('queuedFixture.calls.length'), 1)
    // 队列清空通知先到，RPC 尚未回包；处理中不能因此被隐藏。
    await read('queuedFixture.hideNotes()')
    await click(chip)
    assert.equal(
      await read(
        `document.querySelector(${JSON.stringify(deliver)}).disabled ?? document.querySelector(${JSON.stringify(deliver)}).getAttribute('aria-disabled') === 'true'`,
      ),
      true,
    )
    if (mobile) await read('queuedFixture.away()')
    else {
      await click('#other-action')
      await click('#toggle-card')
    }
    await until(() => read('performance.now() - clickAt > 20200'), '注入延迟应答', 25000)
    if (mobile) await read('queuedFixture.open()')
    else await click('#toggle-card')
    await until(
      () => read(`document.querySelector(${JSON.stringify(chip)})?.textContent.includes('失败')`),
      '晚到错误仍可见',
    )
    if (!(await read(`!!document.querySelector(${JSON.stringify(panel)})`))) await click(chip)
    assert.match(
      await read(`document.querySelector(${JSON.stringify(panel)}).textContent`),
      /隔离设备投递失败/,
    )
    await read('queuedFixture.reset()')
    await click(deliver)
    await until(() => read('queuedFixture.calls.length === 2'), '重试')
    await read('queuedFixture.ack()')
    await until(() => read(`!document.querySelector(${JSON.stringify(chip)})`), '成功后移除提示')
  }
  assert.deepEqual(errors, [])
  const artifact = join(root, '.artifacts/queued-notes-ui')
  mkdirSync(artifact, { recursive: true })
  const result = {
    mobile,
    baseline: baselineRef,
    injectedMs: 20000,
    closeMs: Math.round(closeMs * 10) / 10,
    errors,
  }
  writeFileSync(
    join(artifact, `${mobile ? 'mobile' : baseline ? 'baseline' : 'desktop'}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  console.log(JSON.stringify(result))
} catch (error) {
  if (cdp)
    console.error(
      JSON.stringify(
        await cdp.call('Runtime.evaluate', {
          expression: '({text:document.body.innerText,calls:window.queuedFixture?.calls})',
          returnByValue: true,
        }),
      ),
    )
  throw error
} finally {
  cdp?.close()
  browser.kill()
  await vite?.close()
  await fixture?.close()
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once('exit', resolve),
  )
  rmSync(state, { recursive: true, force: true })
}
