// 正式桌面组件 / 手机网页预览 + 延迟核心，观察真实 DOM 提交时间。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { mobileLatencyFixture } from './stop-latency-mobile-fixture.mjs'

const mobile = process.argv.includes('--mobile')
const mobileUi = mobile ? await mobileLatencyFixture() : null
const vite = mobile
  ? null
  : await createServer({
      root: resolve('packages/ui'),
      server: { host: '127.0.0.1', port: 0, hmr: false },
      logLevel: 'error',
    })
await vite?.listen()
const url = mobileUi
  ? `${mobileUi.url}/?app=1&lang=zh-CN&skin=standard`
  : `${vite.resolvedUrls.local[0]}test/stop-latency-fixture.html?lang=zh-CN`
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
const root = mkdtempSync(join(tmpdir(), 'litch-feedback-'))
const browser = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${root}/profile`,
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
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, 'codex'), TMPDIR: root },
    stdio: 'ignore',
  },
)
let cdp
const errors = []
try {
  const port = await until(
    () => Number(readFileSync(join(root, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '调试端口',
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
  if (mobile)
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
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `const nativeTimeout = window.setTimeout; window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 30000 && window.fastTimeout ? 50 : ms, ...args);`,
  })
  await cdp.call('Page.navigate', { url })
  if (mobile) {
    await until(() => read('!!window.latency'), '手机模拟核心', 120000)
    await read('window.latency.open()')
  }
  const stop = mobile ? '[data-testid="composer-send"]' : '.send.stop'
  await until(() => read(`!!document.querySelector(${JSON.stringify(stop)})`), '停止按钮', 60000)
  const measure = (selector, text) =>
    read(`new Promise((resolve,reject)=>{
    const start=performance.now();
    const observer=new MutationObserver(()=>{
      if(!document.body.innerText.includes(${JSON.stringify(text)})) return;
      observer.disconnect();requestAnimationFrame(()=>resolve(performance.now()-start));
    });observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    const button=document.querySelector(${JSON.stringify(selector)});button.click();button.click();
    setTimeout(()=>{observer.disconnect();reject(new Error('反馈未出现'))},1000);
  })`)
  const stopped = await measure(stop, '正在停止…')
  assert.ok(stopped < 100, `停止反馈 ${stopped}ms`)
  assert.deepEqual(await read('window.latency.calls'), ['session.interrupt'])
  await read('window.latency.fail()')
  await until(() => read('document.body.innerText.includes("延迟引擎拒绝")'), '停止失败提示')
  await read('window.fastTimeout=true')
  await measure(stop, '正在停止…')
  await until(() => read('document.body.innerText.includes("等待停止确认超时")'), '停止确认超时')
  await read('window.latency.ack()')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(stop)}).getAttribute('aria-disabled') === 'true' || document.querySelector(${JSON.stringify(stop)}).disabled`,
    ),
    true,
    'ACK 不代表终态，保持禁用',
  )
  await read('window.latency.fail()') // 已应答的 Promise 无影响。
  await read('window.latency.end()')
  await until(() => read('!document.body.innerText.includes("正在停止…")'), '终态解除等待')
  await read('window.fastTimeout=false')
  if (mobile) {
    await read(`document.querySelector('[data-testid="turn-menu"]').click()`)
    await until(
      () =>
        read(
          `[...document.querySelectorAll('[role="button"]')].some(e=>e.textContent.includes('编辑消息'))`,
        ),
      '编辑菜单',
    )
    await read(
      `[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent.includes('编辑消息')).click()`,
    )
  } else await read('document.querySelector(".umsg .act-edit").click()')
  const send = mobile ? '[data-testid="edit:send"]' : '.umsg-edit-bar .primary'
  await until(() => read(`!!document.querySelector(${JSON.stringify(send)})`), '编辑框')
  const edited = await measure(send, '正在应用编辑…')
  assert.ok(edited < 100, `编辑反馈 ${edited}ms`)
  assert.equal(await read('document.body.innerText.includes("原消息待替换")'), true)
  mkdirSync('.artifacts/stop-latency', { recursive: true })
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    `.artifacts/stop-latency/${mobile ? 'mobile' : 'desktop'}-editing.png`,
    Buffer.from(shot.data, 'base64'),
  )
  assert.deepEqual(await read('window.latency.calls'), [
    'session.interrupt',
    'session.interrupt',
    'session.edit',
  ])
  await read('window.latency.fail()')
  await until(() => read('document.body.innerText.includes("延迟引擎拒绝")'), '编辑失败保留输入')
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(send)}).disabled || document.querySelector(${JSON.stringify(send)}).getAttribute('aria-disabled') === 'true'`,
    ),
    false,
  )
  await read(`window.fastTimeout=true;document.querySelector(${JSON.stringify(send)}).click()`)
  await until(() => read('document.body.innerText.includes("等待编辑结果超时")'), '超时提示')
  await read('window.latency.fail("timeout")')
  await until(
    () => read('document.body.innerText.includes("尚未确认编辑结果")'),
    'RPC 超时不谎称没有改动',
  )
  await read(`document.querySelector(${JSON.stringify(send)}).click()`)
  await read('window.latency.ack()')
  await until(() => read(`!document.querySelector(${JSON.stringify(send)})`), '编辑成功关闭')
  // 已单独登记的网页键盘控件错误不冒充原生验收；除此之外的异常仍阻止通过。
  const previewWarnings = mobile
    ? errors.filter((error) => error.startsWith('Error: findNodeHandle is not supported on web.'))
    : []
  assert.deepEqual(
    errors.filter((error) => !previewWarnings.includes(error)),
    [],
  )
  mkdirSync('.artifacts/stop-latency', { recursive: true })
  writeFileSync(
    `.artifacts/stop-latency/${mobile ? 'mobile' : 'desktop'}-feedback.json`,
    JSON.stringify({ stopMs: stopped, editMs: edited, errors }, null, 2),
  )
  console.log(JSON.stringify({ mobile, stopMs: stopped, editMs: edited }))
} catch (error) {
  console.error(errors)
  if (cdp)
    console.error(
      JSON.stringify(
        await cdp.call('Runtime.evaluate', {
          expression: 'document.body.innerText',
          returnByValue: true,
        }),
      ),
    )
  throw error
} finally {
  cdp?.close()
  const ended = new Promise((resolve) => browser.once('exit', resolve))
  browser.kill('SIGKILL')
  await ended
  await vite?.close()
  await mobileUi?.close()
  rmSync(root, { recursive: true, force: true })
}
