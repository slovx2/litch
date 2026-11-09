// 隔离 Chrome 窗口：正式卡片/编辑框 + 20 秒延迟回包，量弹窗关闭时间，并验失败、切页与重试。
// --baseline <commit> 只把编辑框换成改动前的源码，量同一夹具的旧阻塞时长。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const baselineIndex = process.argv.indexOf('--baseline')
const baseline = baselineIndex !== -1
const baselineRef = baseline ? process.argv[baselineIndex + 1] : null
if (baseline && !baselineRef) throw new Error('--baseline 需要基线提交号')
const root = resolve(import.meta.dirname, '..')
const vite = await createServer({
  root: join(root, 'packages/ui'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: baseline
    ? [
        {
          name: 'before-proposal-dialog',
          enforce: 'pre',
          load(id) {
            if (id === join(root, 'packages/ui/src/tree/SpawnDialog.tsx'))
              return execFileSync(
                'git',
                ['-C', root, 'show', `${baselineRef}:packages/ui/src/tree/SpawnDialog.tsx`],
                { encoding: 'utf8' },
              )
          },
        },
      ]
    : [],
})
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
assert.ok(binary)
const state = mkdtempSync(join(tmpdir(), 'litch-proposal-'))
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
  const fill = async (selector, text) =>
    read(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  const enter = (selector, options = {}) =>
    read(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)});
    const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true,...${JSON.stringify(options)}});
    input.dispatchEvent(event); return event.defaultPrevented;
  })()`)
  await cdp.call('Page.navigate', {
    url: `${vite.resolvedUrls.local[0]}test/proposal-start-fixture.html`,
  })
  if (!baseline) {
    await until(() => read('!!document.querySelector(".prop-note")'), '卡片说明框')
    await fill('.prop-note', '卡片里先写的补充')
  }
  await click('[data-act="edit"]')
  await until(() => read('!!document.querySelector("dialog[open]")'), '编辑弹窗')
  if (!baseline) {
    assert.equal(await read('document.querySelector("#spawn-note").value'), '卡片里先写的补充')
    await fill('#spawn-note', '只检查远程设备\n保留当前分支')
    assert.equal(await enter('#spawn-note', { shiftKey: true }), false)
    assert.equal(await enter('#spawn-note', { isComposing: true }), false)
    assert.equal(await read('proposalFixture.calls.length'), 0)
  }
  await read(`window.closeMeasure = new Promise(resolve => {
    const begin=performance.now();
    const observer=new MutationObserver(() => {
      if (!document.querySelector('dialog[open]')) { observer.disconnect(); window.closedAfterMs=performance.now()-begin; resolve(window.closedAfterMs); }
    }); observer.observe(document.body,{subtree:true,childList:true,attributes:true});
    setTimeout(() => proposalFixture.ack(),20000);
  }); true`)
  if (baseline) await click('dialog button[type="submit"]')
  else await enter('#spawn-note')
  if (!baseline) {
    await until(() => read('!document.querySelector("dialog[open]")'), '立即关闭弹窗')
    assert.match(await read('document.querySelector("[data-act=start]").textContent'), /正在开始/)
    await click('#other-action')
    assert.equal(await read('document.querySelector("#other-action").textContent'), '其他操作 1')
    await click('#toggle-card')
    await click('#toggle-card')
    assert.match(await read('document.querySelector("[data-act=start]").textContent'), /正在开始/)
    await until(() => read('proposalFixture.calls.length === 1'), '只发一次开始')
    assert.match(
      await read('proposalFixture.calls[0].overrides.prompt'),
      /用户补充说明：\n只检查远程设备\n保留当前分支$/,
    )
  }
  await until(() => read("typeof window.closedAfterMs === 'number'"), '关闭耗时', 30000)
  const closeMs = await read('closedAfterMs')
  if (!baseline) assert.ok(closeMs < 1000, `关闭耗时 ${closeMs}`)
  await until(
    () => read('document.querySelector("[data-status]")?.dataset.status === "started"'),
    '启动完成',
    25000,
  )
  assert.ok(await read('!!document.querySelector("[data-child]")'))
  // 重新载入测试迟到失败：关闭编辑框后，卡片仍报错并能重试原修改。
  if (!baseline) {
    await cdp.call('Page.reload')
    await click('[data-act="edit"]')
    await fill('#spawn-note', '失败后仍保留这条补充')
    await enter('#spawn-note')
    await until(() => read('proposalFixture.calls.length === 1'), '延迟开始')
    await click('#toggle-card')
    await read('proposalFixture.fail()')
    await click('#toggle-card')
    await until(
      () => read('document.body.textContent.includes("隔离设备启动失败")'),
      '卡片保留失败',
    )
    await read(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent==='重试开始').click()`,
    )
    await until(() => read('proposalFixture.calls.length === 2'), '重试已发送')
    assert.deepEqual(await read('proposalFixture.calls[1]'), await read('proposalFixture.calls[0]'))
    await read('proposalFixture.ack()')
    await until(
      () => read('document.querySelector("[data-status]")?.dataset.status === "started"'),
      '重试成功',
    )
    // 卡上的轻量输入直接 Enter 开始，也保留 Shift+Enter 与输入法。
    await cdp.call('Page.reload')
    await until(() => read('!!document.querySelector(".prop-note")'), '卡片说明框')
    await fill('.prop-note', '卡片直接补充')
    assert.equal(await enter('.prop-note', { shiftKey: true }), false)
    assert.equal(await enter('.prop-note', { keyCode: 229 }), false)
    await enter('.prop-note')
    await until(() => read('proposalFixture.calls.length === 1'), '卡片直接开始')
    assert.match(
      await read('proposalFixture.calls[0].overrides.prompt'),
      /用户补充说明：\n卡片直接补充$/,
    )
    await read('proposalFixture.ack()')
  }
  assert.deepEqual(errors, [])
  const artifact = join(root, '.artifacts/proposal-start-ui')
  mkdirSync(artifact, { recursive: true })
  const result = {
    baseline,
    injectedAckMs: 20000,
    dialogCloseMs: Math.round(closeMs * 10) / 10,
    errors,
  }
  writeFileSync(
    join(artifact, baseline ? 'before.json' : 'after.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    join(artifact, baseline ? 'before.png' : 'after.png'),
    Buffer.from(screenshot.data, 'base64'),
  )
  console.log(JSON.stringify(result))
} finally {
  cdp?.close()
  browser.kill()
  await vite.close()
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once('exit', resolve),
  )
  rmSync(state, { recursive: true, force: true })
}
