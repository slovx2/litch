// 正式两端输入框 + 真实核心 + 内存 JSON-RPC 对端；不连接真实设备。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const mobile = process.argv.includes('--mobile')
const evidence = process.env.LITCH_COMPOSE_EVIDENCE
const work = mkdtempSync(join(tmpdir(), 'nebula-compose-'))
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
const vite = mobile
  ? null
  : await createServer({
      root: new URL('../packages/ui', import.meta.url).pathname,
      server: { host: '127.0.0.1', port: 0, hmr: false },
      logLevel: 'error',
    })
let browser, cdp
try {
  await vite?.listen()
  const base = mobile
    ? (process.env.LITCH_COMPOSE_UI ?? 'http://127.0.0.1:5189/?app=1&scene=compose-state')
    : `${vite.resolvedUrls.local[0]}test/compose-state-fixture.html`
  browser = spawn(
    binary,
    withChromiumTestArgs([
      '--headless=new',
      `--user-data-dir=${work}/profile`,
      '--remote-debugging-port=0',
      '--no-first-run',
      'about:blank',
    ]),
    {
      env: { PATH: process.env.PATH, HOME: work, TMPDIR: work },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let log = ''
  browser.stderr.on('data', (chunk) => {
    log += chunk
  })
  cdp = await Cdp.connect(
    await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (name, params) => cdp.call(name, params, sessionId)
  const read = async (expression) => {
    const r = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  await call('Runtime.enable')
  cdp.listeners.add((m) => {
    if (m.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(m.params))
  })
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 390 : 1000,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const wait = (expression) =>
    until(() => read(expression), expression).catch(async (error) => {
      console.error(await read('document.body.innerText.slice(0,2000)'))
      throw error
    })
  const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const shot = async (name) => {
    if (!evidence) return
    await read('Promise.all([...document.images].map(image=>image.decode().catch(()=>{})))')
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    mkdirSync(evidence, { recursive: true })
    const r = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(evidence, `${mobile ? 'mobile' : 'desktop'}-${name}.png`),
      Buffer.from(r.data, 'base64'),
    )
  }
  await call('Page.navigate', { url: base })
  await wait('!!window.__composeState && !!document.querySelector("textarea")')
  await wait('window.__composeState.calls().some(c=>c.method==="thread/resume")')
  await read('window.__composeState.offline()')
  await wait(
    'document.body.innerText.includes("未连接") || document.body.innerText.includes("重新连接")',
  )
  const image = `(()=>{const c=document.createElement('canvas');c.width=40;c.height=24;const x=c.getContext('2d');x.fillStyle='#5786c6';x.fillRect(0,0,40,24);return c.toDataURL('image/png')})()`
  if (!mobile) {
    for (const method of ['select', 'paste', 'drop']) {
      await read(
        `(async()=>{const blob=new Blob([Uint8Array.from(atob((${image}).split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});const d=new DataTransfer();d.items.add(new File([blob],'nebula-${method}.png',{type:'image/png'}));${method === 'select' ? `const input=document.querySelector('input[type=file]');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));` : method === 'paste' ? `document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));` : `document.querySelector('.cmp').dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));`}})()`,
      )
      await wait(
        `document.querySelectorAll('.cmp-atts img').length===${['select', 'paste', 'drop'].indexOf(method) + 1}`,
      )
    }
    await click('.cmp-atts button')
    await wait('!!document.querySelector(".viewer")')
    await click('.viewer-x')
    await wait('!document.querySelector(".viewer")')
    await click('.cmp-att-x')
    await wait('document.querySelectorAll(".cmp-atts img").length===2')
    await read(
      `(()=>{const d=new DataTransfer();d.items.add(new File(['nebula local draft'],'nebula.txt',{type:'text/plain'}));const e=document.querySelector('input[type=file]');e.files=d.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    )
    await wait('!!document.querySelector(".cmp-file-card")')
  } else {
    // ImagePicker 的系统文件框由测试文件代替；其读取和正式草稿路径照常执行。
    await read(
      `window.__pickData=${image};document.addEventListener('click',function(e){const input=e.target;if(!(input instanceof HTMLInputElement)||input.type!=='file')return;e.preventDefault();e.stopImmediatePropagation();void(async()=>{const blob=new Blob([Uint8Array.from(atob(window.__pickData.split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});const d=new DataTransfer();d.items.add(new File([blob],'nebula.png',{type:'image/png'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()},true)`,
    )
    await click('[data-testid="composer-more"]')
    await wait('!!document.querySelector("[data-testid=composer-image]")')
    await click('[data-testid="composer-image"]')
    await wait('!!document.querySelector("[data-testid=composer-image-view-0]")')
    await wait('!document.querySelector("[data-testid=composer-image]")')
    assert.ok(
      await read(
        `document.querySelector('[data-testid=composer-image-view-0]').getBoundingClientRect().height>=50`,
      ),
    )
  }
  assert.equal(
    await read(
      'window.__composeState.calls().filter(c=>c.method==="fs/writeFile" || c.method==="turn/steer").length',
    ),
    0,
  )
  await shot('offline-images')
  await read('window.__composeState.online()')
  await wait(
    '!document.body.innerText.includes("未连接") && !document.body.innerText.includes("重新连接")',
  )
  const send = mobile ? '[data-testid="composer-send"]' : 'button.send'
  await click(send)
  await wait('window.__composeState.calls().filter(c=>c.method==="turn/steer").length===1')
  assert.equal(
    await read(
      'window.__composeState.calls().find(c=>c.method==="turn/steer").params.input.some(i=>i.type==="image")',
    ),
    true,
  )
  if (!mobile)
    assert.equal(
      await read('window.__composeState.calls().filter(c=>c.method==="fs/writeFile").length'),
      1,
    )
  // 重新载入只清空界面草稿；压缩验收在独立实例里进行，避免上一条附件影响结果。
  const previous = await read('window.__composeState.token')
  await read('localStorage.clear()')
  await call('Page.navigate', { url: base })
  await wait(
    `!!window.__composeState && window.__composeState.token!==${JSON.stringify(previous)} && !!document.querySelector("textarea")`,
  )
  await wait('window.__composeState.calls().some(c=>c.method==="thread/resume")')
  await read('window.__composeState.startCompact()')
  await wait('document.body.innerText.includes("压缩")')
  await read(
    `(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'请优先检查星云报告');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  )
  await wait(`!!document.querySelector(${JSON.stringify(send)})`)
  await click(send)
  await wait('document.body.innerText.includes("请优先检查星云报告")')
  assert.equal(
    await read('window.__composeState.calls().filter(c=>c.method==="turn/steer").length'),
    0,
  )
  assert.equal(await read('document.body.innerText.includes("压缩结束后发送")'), false)
  await shot('compacting-pending')
  await read('window.__composeState.finishCompact()')
  await wait('window.__composeState.calls().filter(c=>c.method==="turn/steer").length===1')
  await wait(
    mobile
      ? '!document.querySelector("[data-testid=queue]") && !!document.querySelector("[data-testid=user-message]")'
      : '!document.querySelector(".tray") && !!document.querySelector(".umsg")',
  )
  await shot('compaction-delivered')
  console.log(
    `PASS ${mobile ? 'mobile' : 'desktop'} offline images and automatic post-compaction steer`,
  )
} finally {
  cdp?.close()
  if (browser && browser.exitCode === null) {
    const exited = new Promise((r) => browser.once('exit', r))
    browser.kill()
    await exited
  }
  await vite?.close()
  rmSync(work, { recursive: true, force: true })
}
