// 先在 apps/mobile 启动 npm run preview，再运行：node scripts/check-mobile-web-keyboard.mjs http://127.0.0.1:5189
// 正式预览页面 + 模拟核心；隔离 Chrome for Testing，不使用个人浏览器或模型凭据。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5189')
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), '只允许本机预览')
url.search = '?app=1&lang=zh-CN'
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
assert.ok(binary, '需要 Chrome for Testing 或 LITCH_CHROME_BINARY')
const home = mkdtempSync(join(tmpdir(), 'litch-web-keyboard-'))
const out = `.artifacts/web-keyboard/${Date.now()}-${process.pid}`
mkdirSync(out, { recursive: true })
const browser = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${home}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, 'codex'), TMPDIR: home },
    stdio: 'ignore',
  },
)
const report = { url: String(url), checks: [], exceptions: [], consoleErrors: [] }
let cdp
try {
  const port = await until(
    () => Number(readFileSync(join(home, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '调试端口',
  )
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  cdp = await Cdp.connect(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl)
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
      report.exceptions.push(
        event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text,
      )
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      report.consoleErrors.push(
        event.params.args.map((arg) => arg.value ?? arg.description).join(' '),
      )
  })
  const read = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const selector = (id) => `[data-testid="${id}"]`
  const click = async (id) => {
    const target = JSON.stringify(selector(id))
    await until(() => read(`!!document.querySelector(${target})`), id, 120000)
    await read(`document.querySelector(${target}).click()`)
  }
  const inputValue = () => read(`document.querySelector('[data-testid="edit:input"]')?.value`)
  const openEdit = async () => {
    await click('turn-menu')
    await until(
      () =>
        read(
          `[...document.querySelectorAll('[role="button"]')].some(e=>e.textContent==='编辑消息')`,
        ),
      '编辑菜单',
    )
    await read(
      `[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent==='编辑消息').click()`,
    )
    await until(inputValue, '编辑输入框')
  }
  const type = async (text) => {
    await read(`document.querySelector('[data-testid="edit:input"]').focus()`)
    await cdp.call('Input.insertText', { text })
    await until(async () => (await inputValue())?.includes(text), '输入生效')
  }
  await cdp.call('Page.navigate', { url: String(url) })
  await click('device:build')
  await click('session:b6')
  await openEdit()
  const original = await inputValue()
  await type('取消验收')
  await click('edit:cancel')
  await until(() => read(`!document.querySelector('[data-testid="edit:input"]')`), '取消关闭')
  await openEdit()
  assert.equal(await inputValue(), original, '取消没有改写原消息')
  report.checks.push('打开普通 Codex 会话编辑框、输入、取消、再次打开原文不变')
  await type('网页键盘提交验收')
  const edited = await inputValue()
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}/editing.png`, Buffer.from(shot.data, 'base64'))
  await click('edit:send')
  await until(() => read(`!document.querySelector('[data-testid="edit:input"]')`), '提交关闭')
  await until(
    () => read(`document.body.innerText.includes(${JSON.stringify(edited)})`),
    '新消息显示',
  )
  report.checks.push('提交成功、弹窗关闭、新消息显示')
  await openEdit()
  assert.equal(await inputValue(), edited, '再次编辑读到提交内容')
  await click('edit:cancel')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(report.exceptions, [], '不允许未捕获异常')
  assert.deepEqual(
    report.consoleErrors.filter((text) => text.includes('findNodeHandle')),
    [],
    '不允许 findNodeHandle 控制台错误',
  )
  report.checks.push('完整过程无未捕获异常或 findNodeHandle 控制台错误')
  console.log(
    JSON.stringify(
      { out, checks: report.checks, consoleErrors: report.consoleErrors.length },
      null,
      2,
    ),
  )
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2))
  cdp?.close()
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await exited
  }
  rmSync(home, { recursive: true, force: true })
}
