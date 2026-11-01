// 手机控制台的正式页面预览；隔离无头浏览器，先运行 mobile preview。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url =
  process.argv[2] ??
  'http://127.0.0.1:5189/?app=1&scene=manager-console&skin=standard&appearance=light&lang=zh-CN'
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
const output =
  process.env.LITCH_SUGGESTION_SHOTS ?? join(process.cwd(), '.artifacts/manager-v3-mobile')
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
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector, 60000)
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `M9-${name}.png`), Buffer.from(picture.data, 'base64'))
  }

  await call('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  await wait('[data-testid="manager-console"]')
  const press = async (text) => {
    assert.ok(
      await read(
        `(()=>{const button=[...document.querySelectorAll('[role="button"],button')].find(e=>e.textContent===${JSON.stringify(text)});if(!button)return false;button.click();return true})()`,
      ),
      text,
    )
    await new Promise((r) => setTimeout(r, 150))
  }
  for (const skin of ['standard', 'human', 'retro']) {
    await read(`window.__litchLook.set({skin:${JSON.stringify(skin)},theme:'light'})`)
    await wait('[data-testid="manager-console"]')
    await press('报告')
    await wait('[data-testid="manager-issue:P-1"]')
    await shot(`mobile-report-${skin}`)
    await press('关联')
    await shot(`mobile-relations-${skin}`)

    await press('I-2 · 回退编辑：手机端跟进')
    await shot(`mobile-related-item-${skin}`)
  }
  await press('报告')
  await press('标记已阅')
  await until(
    () =>
      read(
        "document.body.innerText.includes('已阅') && !document.body.innerText.includes('标记已阅')",
      ),
    '标记已阅',
  )
  await press('追问')
  await read(
    `(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'手机追问范围');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await new Promise((r) => setTimeout(r, 150))
  await press('提交追问')
  await until(() => read("document.body.innerText.includes('已核对这条内容')"), '经理回复')
  await shot('mobile-report-discussion')
  await press('请你做')
  await press('已复验')
  await until(() => read("document.body.innerText.includes('已交付')"), '交付请求')
  await shot('mobile-delivery')
  console.log('手机控制台正式页面：三皮肤报告、关联定位、已阅、追问与交付通过')
} catch (error) {
  console.error(error)
  throw error
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  console.log(`隔离浏览器已关闭，临时目录：${work}`)
}
