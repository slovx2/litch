// 无头、隔离 HOME 的真实浏览器验收；只连内存模拟核心，不留下截图或运行目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
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
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ]),
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
  const resolvedBefore = await evaluate('window.__attachments.resolves()')
  await evaluate('window.__attachments.expire()')
  await evaluate(`document.querySelector('.umsg .attachment-card-open').click()`)
  await until(
    () =>
      evaluate(
        `document.querySelector('.umsg .attachment-card-info small').textContent === '已清理'`,
      ),
    '已清理状态',
  )
  assert.equal(
    await evaluate(`document.querySelector('.umsg .attachment-card-open').disabled`),
    true,
  )
  assert.equal(await evaluate('window.__attachments.resolves()'), resolvedBefore)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-card-error').length`), 0)
  // 必须经正式 UserMessage 渲染；手工给 UserAttachments 传设备会掩盖历史消息丢上下文。
  const nativePath = '/fixtures/native/11.04 明细 比价(1)(1).xls'
  const uploaded = await evaluate(`window.__attachments.upload('build')`)
  assert.ok(uploaded.path.includes('/.litch/attachments/'))
  for (const scene of [
    { deviceId: 'local', target: 'local', path: nativePath },
    { deviceId: 'build', target: 'build', path: uploaded.path },
    { deviceId: 'build', target: 'local', path: nativePath, client: true },
  ]) {
    await evaluate(
      `window.__attachments.show(${JSON.stringify(scene.deviceId)}, ${JSON.stringify({
        text: '查看先前发送的附件',
        images: [],
        extras: [
          {
            kind: 'file',
            name: '11.04 明细 比价(1)(1).xls',
            path: scene.path,
            ...(scene.client ? { client: true } : {}),
          },
        ],
      })})`,
    )
    await until(
      () =>
        evaluate(
          `document.querySelector('.umsg .attachment-card-info .ell')?.textContent === '11.04 明细 比价(1)(1).xls'`,
        ),
      '历史附件',
    )
    for (const reopen of [false, true]) {
      if (reopen) await evaluate('window.__attachments.remount()')
      const before = await evaluate('window.__attachments.resolves()')
      await evaluate(`document.querySelector('.umsg .attachment-card-open').click()`)
      await until(() => evaluate(`window.__attachments.resolves() > ${before}`), '附件路由')
      const request = await evaluate('window.__attachments.requests().at(-1)')
      assert.equal(request.deviceId, scene.target)
      assert.equal(request.ref.path, scene.path)
      await until(
        () => evaluate(`window.__attachments.opened()?.active === ${JSON.stringify(scene.path)}`),
        '原设备或设备副本打开',
      )
      assert.equal(await evaluate('document.querySelectorAll(".attachment-card-error").length'), 0)
    }
  }
  for (const [reason, text] of [
    ['missing', '文件或目录不存在'],
    ['permission', '没有读取权限'],
    ['offline', '设备未连接'],
  ]) {
    await evaluate(`window.__attachments.fail(${JSON.stringify(reason)})`)
    await evaluate(`document.querySelector('.umsg .attachment-card-open').click()`)
    await until(
      () => evaluate(`!!document.querySelector('.file-link-dialog[open]')`),
      '真实失败原因',
    )
    const message = await evaluate(
      `document.querySelector('.file-link-dialog .modal-body').textContent`,
    )
    assert.ok(message.includes(text), `${reason}: ${message}`)
    assert.ok(!message.includes('请在上传此文件的电脑上打开'))
    if (reason === 'missing' && process.env.LITCH_ATTACHMENT_SHOTS) {
      mkdirSync(process.env.LITCH_ATTACHMENT_SHOTS, { recursive: true })
      writeFileSync(
        join(process.env.LITCH_ATTACHMENT_SHOTS, 'missing-file.png'),
        Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      )
    }
    await evaluate(
      `document.querySelector('.file-link-dialog .modal-foot button:last-child').click()`,
    )
    await until(() => evaluate('!document.querySelector(".file-link-dialog")'), '关闭错误弹层')
  }
  assert.deepEqual(errors, [])
  console.log(
    '通过：选择上传、正式消息/重开后的设备路由、本机与远程副本、控制端文件、真实失败原因、三皮肤两宽度、已清理状态',
  )
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
