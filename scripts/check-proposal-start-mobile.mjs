// 正式手机页面的 Web 预览：20 秒设备回包延迟下，编辑页先返回，卡片显示进度与可重试的失败。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { mobileProposalFixture } from './proposal-start-mobile-fixture.mjs'

const fixture = await mobileProposalFixture()
const root = resolve(import.meta.dirname, '..')
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
const state = mkdtempSync(join(tmpdir(), 'litch-proposal-mobile-'))
const browser = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${state}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ]),
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
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
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
  const fill = async (selector, text) =>
    read(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  const enter = (selector, options = {}) =>
    read(`(() => {
    const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true,...${JSON.stringify(options)}});
    document.querySelector(${JSON.stringify(selector)}).dispatchEvent(event); return event.defaultPrevented;
  })()`)
  const visible = (selector) =>
    read(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e => e.getBoundingClientRect().width > 0)`,
    )
  await cdp.call('Page.navigate', { url: `${fixture.url}/?app=1&lang=zh-CN&skin=standard` })
  await until(() => read('!!window.proposalFixture'), '手机夹具', 120000)
  await read('proposalFixture.open()')
  const firstStart = '[data-testid^="proposal:"][data-testid$=":start"]:not([aria-disabled="true"])'
  await until(() => read(`!!document.querySelector(${JSON.stringify(firstStart)})`), '建议卡')
  const id = await read(
    `Array.from(document.querySelectorAll(${JSON.stringify(firstStart)})).at(-1).dataset.testid.slice(9,-6)`,
  )
  await read(`proposalFixture.edit(${JSON.stringify(id)})`)
  await until(() => visible('[data-testid="proposal-start"]'), '编辑页')
  const note = '[data-testid="proposal-start"] [data-testid="proposal-note"]'
  await until(() => read(`!!document.querySelector(${JSON.stringify(note)})`), '补充说明')
  await fill(note, '手机补充\n检查远程')
  await enter(note, { shiftKey: true })
  await enter(note, { isComposing: true })
  assert.equal(await read('proposalFixture.calls.length'), 0)
  await read(`window.begin=performance.now(); setTimeout(() => proposalFixture.fail(),20000); true`)
  await enter(note)
  await until(() => read('proposalFixture.calls.length === 1'), '开始命令')
  await until(async () => !(await visible('[data-testid="proposal-start"]')), '编辑页立即返回')
  const returnMs = await read('performance.now()-begin')
  assert.ok(returnMs < 1500, `返回耗时 ${returnMs}ms`)
  const start = `[data-testid="proposal:${id}:start"]`
  assert.match(
    await read(`document.querySelector(${JSON.stringify(start)}).textContent`),
    /正在开始/,
  )
  assert.match(
    await read('proposalFixture.calls[0].overrides.prompt'),
    /用户补充说明：\n手机补充\n检查远程$/,
  )
  await until(
    () => read('document.body.textContent.includes("隔离设备启动失败")'),
    '卡片显示迟到失败',
    25000,
  )
  await read(
    `Array.from(document.querySelectorAll('[role=button]')).find(b => b.textContent==='重试开始').click()`,
  )
  await until(() => read('proposalFixture.calls.length === 2'), '重试发送')
  assert.deepEqual(await read('proposalFixture.calls[1]'), await read('proposalFixture.calls[0]'))
  await read('proposalFixture.ack()')
  await until(() => read(`!document.querySelector(${JSON.stringify(start)})`), '卡片已开始')
  assert.equal(await read('document.body.textContent.includes("隔离设备启动失败")'), false)
  assert.deepEqual(errors, [])
  const artifact = join(root, '.artifacts/proposal-start-ui')
  mkdirSync(artifact, { recursive: true })
  const result = { injectedFailureMs: 20000, returnMs: Math.round(returnMs * 10) / 10, errors }
  writeFileSync(join(artifact, 'mobile.json'), `${JSON.stringify(result, null, 2)}\n`)
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(artifact, 'mobile.png'), Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify(result))
} catch (error) {
  if (cdp)
    console.error(
      JSON.stringify(
        await cdp.call('Runtime.evaluate', {
          expression:
            '({text:document.body.innerText,calls:window.proposalFixture?.calls,notes:Array.from(document.querySelectorAll("textarea")).map(e=>({id:e.dataset.testid,value:e.value}))})',
          returnByValue: true,
        }),
      ),
    )
  throw error
} finally {
  cdp?.close()
  browser.kill()
  await fixture.close()
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once('exit', resolve),
  )
  rmSync(state, { recursive: true, force: true })
}
