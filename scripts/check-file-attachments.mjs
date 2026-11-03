// 无头、隔离 HOME 的真实浏览器验收；只连内存模拟核心，不留下截图或运行目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const binary = globSync(
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
).at(-1)
assert.ok(binary, '需要隔离 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-file-card-'))
const reserve = createServer()
await new Promise((r) => reserve.listen(0, '127.0.0.1', r))
const port = reserve.address().port
await new Promise((r) => reserve.close(r))
const env = { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex'), TMPDIR: work }
const vite = spawn(
  process.execPath,
  [
    resolve('packages/ui/node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  { cwd: resolve('packages/ui'), env, stdio: 'ignore' },
)
const browser = spawn(
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
    'about:blank',
  ],
  { env, stdio: 'ignore' },
)
let cdp
try {
  const base = `http://127.0.0.1:${port}`
  await until(async () => (await fetch(`${base}/test/attachments-fixture.html`)).ok, 'Vite')
  const debug = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    'Chrome',
  )
  const url = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(
        (t) => t.type === 'page',
      )?.webSocketDebuggerUrl,
    '页面',
  )
  cdp = await Cdp.connect(url)
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')
  const errors = []
  cdp.listeners.add((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
  })
  const evaluate = async (expression) => {
    const r = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  await cdp.call('Page.navigate', { url: `${base}/test/attachments-fixture.html` })
  await until(() => evaluate(`!!document.querySelector('input[type=file]')`), '输入框')
  const name = `${'超长文件名称'.repeat(35)}.txt`
  await evaluate(
    `(()=>{const input=document.querySelector('input[type=file]');const d=new DataTransfer();d.items.add(new File(['附件测试正文'],${JSON.stringify(name)},{type:'text/plain'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  )
  await until(() => evaluate(`!!document.querySelector('.cmp-file-card')`), '输入区文件卡')
  assert.equal(await evaluate(`document.querySelector('.cmp-file-card .ell').textContent`), name)
  await evaluate(`document.querySelector('button.send').click()`)
  await until(() => evaluate(`!!document.querySelector('.umsg .attachment-card')`), '已发送文件卡')
  const sent = await evaluate('window.__attachments.sent()')
  assert.equal(sent.text, '')
  assert.equal(sent.attachments[0].label, name)
  assert.ok(sent.attachments[0].path.includes('/.litch/attachments/'))
  for (const width of [360, 800])
    for (const skin of ['standard', 'retro', 'human']) {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await evaluate(`window.__litchLook.set({skin:${JSON.stringify(skin)}})`)
      await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      const fits = await evaluate(
        `(()=>{const b=document.querySelector('.umsg').getBoundingClientRect();const a=document.querySelector('.umsg .attachment-card').getBoundingClientRect();const n=document.querySelector('.umsg .attachment-card-info .ell');return {fits:a.right<=b.right&&a.left>=b.left&&b.right<=innerWidth,truncated:n.scrollWidth>n.clientWidth,ellipsis:getComputedStyle(n).textOverflow}})()`,
      )
      assert.ok(fits.fits, `${width}/${skin} 撑破气泡`)
      assert.ok(fits.truncated)
      assert.equal(fits.ellipsis, 'ellipsis')
    }
  await evaluate(`document.querySelector('.umsg .attachment-card-open').click()`)
  await until(() => evaluate('!!window.__attachments.opened()?.active'), '点击卡片打开文件面板')
  assert.equal(await evaluate('window.__attachments.opened().active'), sent.attachments[0].path)
  assert.deepEqual(errors, [])
  console.log('通过：选择文件、协议上传模拟、输入区/消息文件卡、三皮肤两宽度截断、点击预览')
} finally {
  cdp?.close()
  for (const child of [browser, vite]) {
    if (child.exitCode === null) {
      const closed = once(child, 'exit')
      child.kill('SIGTERM')
      await closed
    }
  }
  rmSync(work, { recursive: true, force: true })
}
