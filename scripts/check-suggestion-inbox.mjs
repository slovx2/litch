// 对着模拟核心的集中建议验收。先起 UI 开发服务器；浏览器无头、用户目录隔离，退出关闭。
// node scripts/check-suggestion-inbox.mjs [http://127.0.0.1:5289]
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url = process.argv[2] ?? 'http://127.0.0.1:5289'
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
if (!binary) throw new Error('需要 LITCH_CHROME_BINARY 指向 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-suggestions-'))
const output = process.env.LITCH_SUGGESTION_SHOTS ?? join(process.cwd(), '.local/suggestion-inbox')
mkdirSync(output, { recursive: true })
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  {
    env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let endpoint = ''
child.stderr.on('data', (chunk) => {
  endpoint += String(chunk)
})
let cdp
try {
  const ws = await until(
    () => endpoint.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    '隔离浏览器',
  )
  assert.ok(
    execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'args='], {
      encoding: 'utf8',
    }).includes(`--user-data-dir=${work}/profile`),
  )
  cdp = await Cdp.connect(ws)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector)
  const click = async (selector) => {
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await new Promise((r) => setTimeout(r, 180))
  }
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `M9-${name}.png`), Buffer.from(picture.data, 'base64'))
  }
  const say = async (text) => {
    await wait('.main .dock textarea.cmp-text')
    await read(
      `(()=>{const e=document.querySelector('.main .dock textarea.cmp-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    )
    await new Promise((r) => setTimeout(r, 100))
    await read(
      `document.querySelector('.main .dock textarea.cmp-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    )
    await wait('.wrap-cards [data-card="proposal"]')
    await until(() => read("!document.querySelector('.main .running-line')"), '回合结束')
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  await wait('.sb-btn.suggestions')
  await read("document.querySelector('.onb .ibtn')?.click()")
  await read("window.__litchLook.set({skin:'standard',theme:'light',lang:'zh-CN'})")
  await click('.row-line[data-session="s6"] .ss-row')
  await say('收尾建议')
  await click('.sb-btn.suggestions')
  await wait('.suggestion-row')
  assert.equal(await read("document.querySelectorAll('.suggestion-row').length"), 2)
  await shot('suggestions-zh')
  await read("window.__litchLook.set({lang:'en'})")
  await shot('suggestions-en')
  await click('.suggestion-row [data-act="edit"]')
  await wait('.spawn-dialog')
  await read(
    "document.querySelector('.spawn-dialog').close();document.querySelector('.spawn-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))",
  )
  // 关闭编辑后忽略一张，列表与角标都应随之减少。
  await click('.suggestion-row [data-act="dismiss"]')
  await until(() => read("document.querySelectorAll('.suggestion-row').length === 1"), '忽略移除')
  await read("window.__litchLook.set({lang:'zh-CN'})")
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await wait('[data-act="manager-suggestions"]')
  await shot('manager-entry')
  await click('[data-act="manager-suggestions"]')
  assert.equal(await read("document.querySelectorAll('.suggestion-row').length"), 0)
  await click('.sb-btn.suggestions')
  await wait('.suggestion-row')
  // 来源点击沿用会话导航；不能留在集中页面。
  await click('.suggestion-row .prop-meta button')
  await wait('.row-line[data-session="s6"] .ss-row.sel')
  await click('.sb-settings')
  await click('.set-go[data-page="devices"]')
  await click('.devp-item[data-device="local"] .devp-row')
  const retention = '[data-setting="sessions.suggestionRetentionDays"]'
  await click('[data-sec="group"][data-group="sessions"] .fold')
  await wait(retention)
  await read(
    `document.querySelector(${JSON.stringify(retention)}).scrollIntoView({block:'center'})`,
  )
  assert.deepEqual(
    await read(
      `Array.from(document.querySelector(${JSON.stringify(`${retention} select`)}).options).map(o=>o.value)`,
    ),
    ['1', '3', '7', '14', '30', 'never'],
  )
  await shot('retention')
  console.log(
    '集中建议界面验收通过：中英文、列表角标、编辑、忽略移除、来源跳转、经理筛选、留存枚举。',
  )
} finally {
  cdp?.close()
  const ended = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await ended
  console.log(`隔离浏览器已关闭，临时目录：${work}`)
}
