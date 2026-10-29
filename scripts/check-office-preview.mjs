// 无前台：隔离 Chrome for Testing，生产构建与 CSP，真实文件面板 + 模拟核心。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const review = process.argv.includes('--review')
const fixture = review ? 'office-review' : 'preview'
const out = join(root, '.local/office-preview-check', `${Date.now()}-${process.pid}`)
mkdirSync(out, { recursive: true })
const binary = globSync(
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
)
  .sort()
  .at(-1)
assert(binary?.includes('for Testing'), '需要已安装的隔离 Chrome for Testing')
const profile = mkdtempSync(join(tmpdir(), 'litch-preview-chrome-'))
const home = join(profile, 'home')
mkdirSync(home)
const report = { checks: [], errors: [], requests: [], output: out }
let browser, server, cdp
const contexts = new Map()
try {
  await build({
    configFile: join(root, 'packages/ui/vite.config.ts'),
    root: join(root, 'packages/ui'),
    logLevel: 'warn',
    build: {
      outDir: join(out, 'assets'),
      rollupOptions: { input: join(root, `packages/ui/test/${fixture}/index.html`) },
    },
  })
  const assets = join(out, 'assets')
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.woff2': 'font/woff2',
    '.mjs': 'text/javascript',
  }
  server = createServer((req, res) => {
    const path = resolve(assets, `.${decodeURIComponent(req.url.split('?')[0])}`)
    if (!path.startsWith(`${assets}/`) || !existsSync(path)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
    res.end(readFileSync(path))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  browser = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--use-mock-keychain',
      '--password-store=basic',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let log = ''
  browser.stderr.on('data', (chunk) => {
    log += chunk
  })
  const ws = await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome CDP')
  const command = execFileSync('ps', ['-p', String(browser.pid), '-o', 'command='], {
    encoding: 'utf8',
  })
  assert(command.includes(`--user-data-dir=${profile}`) && command.includes('--headless=new'))
  cdp = await Cdp.connect(ws)
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, args) => cdp.call(method, args, sessionId)
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      )
    return result.result.value
  }
  cdp.listeners.add((event) => {
    if (event.sessionId !== sessionId) return
    if (event.method === 'Runtime.executionContextCreated')
      contexts.set(event.params.context.id, event.params.context)
    if (event.method === 'Runtime.executionContextDestroyed')
      contexts.delete(event.params.executionContextId)
    if (event.method === 'Runtime.exceptionThrown')
      report.errors.push(event.params.exceptionDetails)
    if (event.method === 'Network.requestWillBeSent') report.requests.push(event.params.request.url)
  })
  await call('Runtime.enable')
  await call('Network.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__officeWorkers=new Set();const Base=Worker;window.Worker=class extends Base{constructor(...args){super(...args);if(/office.worker|zip.worker/.test(String(args[0])))window.__officeWorkers.add(this)}terminate(){window.__officeWorkers.delete(this);super.terminate()}};window.__officeParentSentinel='private';`,
  })
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/test/${fixture}/index.html` })
  await until(
    () => evaluate('document.querySelector(".fp-document h1")?.textContent === "文件预览"'),
    'Markdown 已渲染',
  )
  if (review) {
    const result = await evaluate('window.officeReviewCheck()')
    assert(result.before.includes('.nested'))
    assert(result.after.includes('color: rgb(1, 2, 3)'))
    assert(!/nested|url\(|100000|999999|@media/.test(result.after), result.after)
    assert.equal(result.pageLimit, 'budget')
    report.checks.push('审阅回归：嵌套CSS/分组规则丢弃，替代命名空间前缀分页仍受预算约束')
  }

  const open = async (path, bytes, format) => {
    const result = {
      kind: 'ready',
      format,
      bytes: bytes.length,
      dataBase64: Buffer.from(bytes).toString('base64'),
    }
    await evaluate(
      'window.previewCheck.result(' +
        JSON.stringify(path) +
        ',' +
        JSON.stringify(result) +
        ');window.previewCheck.open(' +
        JSON.stringify(path) +
        ')',
    )
    await until(
      async () => {
        const s = await evaluate('document.querySelector("[data-office]")?.dataset.state')
        return s && s !== 'loading' ? s : null
      },
      'Office finished',
      30000,
    )
    return evaluate('document.querySelector("[data-office]")?.dataset.state')
  }
  const { docx, xlsx, zipOf } = await import('../packages/ui/test/office-fixtures.mjs')
  assert.equal(await open('report.docx', await docx(true), 'docx'), 'ready')
  report.checks.push('DOCX opaque iframe 在生产CSP加载受信脚本并渲染恶意夹具')
  assert.equal(
    await evaluate('document.querySelector(".office-docx").sandbox.value'),
    'allow-scripts',
  )
  assert.equal(
    await evaluate(
      '(()=>{try{return !!document.querySelector(".office-docx").contentWindow.document}catch{return false}})()',
    ),
    false,
  )
  assert.equal(await evaluate('!!window.pwned'), false)
  const targets = await cdp.call('Target.getTargets')
  const target = targets.targetInfos.find((t) => t.type === 'iframe')
  assert(target, 'opaque frame target')
  const { sessionId: frameSession } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const inFrame = async (expression) => {
    const r = await cdp.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      frameSession,
    )
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  assert.equal(
    await inFrame('(()=>{try{return parent.__officeParentSentinel}catch{return "blocked"}})()'),
    'blocked',
  )
  assert.equal(
    await inFrame('document.body.querySelectorAll("script,iframe,object,embed,a[href]").length'),
    0,
  )
  assert.equal(
    await inFrame('!!document.querySelector("header") && !!document.querySelector("footer")'),
    true,
  )
  await inFrame(
    `(()=>{let s=document.createElement('script');s.textContent='window.__inlineRan=true';document.body.append(s);const i=document.createElement('img');i.setAttribute('onerror','window.__eventRan=true');i.src='data:image/png;base64,bad';document.body.append(i)})()`,
  )
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(await inFrame('!!window.__inlineRan||!!window.__eventRan'), false)
  assert.equal(await inFrame('typeof window.litchShell'), 'undefined')
  await inFrame('document.body.lastElementChild.remove();document.body.lastElementChild.remove()')
  report.checks.push('opaque父页面隔离、无bridge、文档脚本/事件被CSP拒绝、页眉页脚')
  for (const skin of ['retro', 'human', 'standard'])
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, theme })})`)
      await new Promise((r) => setTimeout(r, 100))
      writeFileSync(
        join(out, `docx-${skin}-${theme}.png`),
        Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      )
    }
  assert.equal(await open('data.xlsx', await xlsx({ large: true }), 'xlsx'), 'ready')
  assert(
    (await evaluate('document.querySelector(".office-grid").textContent')).includes(
      '001234567890123456789',
    ),
  )
  assert((await evaluate('document.querySelector(".office-grid").textContent')).includes('=1+2'))
  assert((await evaluate('document.querySelectorAll(".office-cell").length')) < 500)
  await evaluate('document.querySelector(".office-grid").scrollTop=279900')
  await until(
    () => evaluate('document.querySelector(".office-grid").textContent.includes("第 10000 行")'),
    'virtual last row',
  )
  await evaluate('document.querySelector(".office-grid").scrollTop=0')
  for (const skin of ['retro', 'human', 'standard'])
    for (const theme of ['light', 'dark']) {
      await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, theme })})`)
      await new Promise((r) => setTimeout(r, 100))
      writeFileSync(
        join(out, `xlsx-${skin}-${theme}.png`),
        Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      )
    }
  await evaluate('document.querySelectorAll(".office-sheets button")[1].click()')
  await until(
    () => evaluate('document.querySelector(".office-grid").textContent.includes("另一个工作表")'),
    'sheet switch',
  )
  report.checks.push('XLSX 多sheet、文本、缓存/无缓存公式、10000行虚拟滚动')
  assert.equal(
    await open('cropped.xlsx', await xlsx({ overflow: true, frozen: true }), 'xlsx'),
    'ready',
  )
  await until(() => evaluate('!!document.querySelector("[data-truncated]")'), '截断提示')
  assert.equal(
    await evaluate('document.querySelector("[data-truncated]").textContent'),
    '仅显示前 10,000 行、200 列。',
  )
  assert.equal(
    await evaluate('document.querySelector(".office-grid").getAttribute("aria-rowcount")'),
    '10000',
  )
  assert.equal(
    await evaluate('document.querySelector(".office-grid").getAttribute("aria-colcount")'),
    '200',
  )
  assert.equal(
    await evaluate('getComputedStyle(document.querySelector(".office-cell[data-num]")).textAlign'),
    'right',
  )
  assert(await evaluate('document.querySelector(".office-grid").textContent.includes("FALSE")'))
  const frozen = await evaluate(
    '(()=>{const e=document.querySelector(\'.office-cell[data-region="rc"]\');const r=e.getBoundingClientRect();return {x:r.x,y:r.y}})()',
  )
  await evaluate('document.querySelector(".office-grid").scrollTo(1400,1200)')
  await new Promise((resolve) => setTimeout(resolve, 120))
  const pinned = await evaluate(
    '(()=>{const e=document.querySelector(\'.office-cell[data-region="rc"]\');const r=e.getBoundingClientRect();return {x:r.x,y:r.y}})()',
  )
  assert.deepEqual(pinned, frozen)
  assert(
    !(await evaluate('document.querySelector(".office-grid").textContent.includes("窗口外数据")')),
  )
  writeFileSync(
    join(out, 'xlsx-truncated-frozen.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  await evaluate('document.querySelectorAll(".office-sheets button")[1].click()')
  await until(() => evaluate('!document.querySelector("[data-truncated]")'), '其他表无截断提示')
  report.checks.push('截断窗口与提示、切sheet清提示、数字右对齐、TRUE/FALSE和冻结窗格')
  for (const format of ['docx', 'xlsx']) {
    assert.equal(await open(`invalid.${format}`, new Uint8Array([1, 2, 3]), format), 'invalid')
    assert.equal(
      await open(`macro.${format}`, await zipOf({ 'word/vbaProject.bin': 'macro' }), format),
      'active',
    )
    assert.equal(
      await open(
        `bomb.${format}`,
        await zipOf({ 'big.txt': 'x'.repeat(40 * 1024 * 1024 + 1) }),
        format,
      ),
      'budget',
    )
  }
  report.checks.push('DOCX/XLSX 损坏、伪装宏和ZIP炸弹错误占位')
  assert.equal(
    report.requests.some((url) => url.startsWith('https://office-probe.invalid')),
    false,
  )
  report.checks.push('无外链资源请求')
  const bytes = await xlsx({ large: true })
  for (let i = 0; i < 25; i++) {
    const result = {
      kind: 'ready',
      format: 'xlsx',
      bytes: bytes.length,
      dataBase64: Buffer.from(bytes).toString('base64'),
    }
    await evaluate(
      'window.previewCheck.result("cancel.xlsx",' +
        JSON.stringify(result) +
        ');window.previewCheck.open("cancel.xlsx")',
    )
    await new Promise((r) => setTimeout(r, 30))
    await evaluate('window.previewCheck.open("Makefile")')
  }
  await until(
    () =>
      evaluate(
        'window.__officeWorkers.size===0 && document.querySelectorAll(".office-docx").length===0',
      ),
    'workers and frames cleaned',
  )
  assert.equal(await evaluate('window.previewCheck.liveUrls()'), 0)
  report.checks.push('25次解析中切文件：Worker终止、frame销毁、无Blob遗留')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  assert.equal(await open('narrow.xlsx', await xlsx(), 'xlsx'), 'ready')
  writeFileSync(
    join(out, 'xlsx-narrow.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  assert.equal(await open('narrow.docx', await docx(), 'docx'), 'ready')
  writeFileSync(
    join(out, 'docx-narrow.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  report.checks.push('760宽布局')
  report.success = true
} finally {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  cdp?.close()
  if (browser && browser.exitCode === null) {
    const stopped = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill('SIGTERM')
    await stopped
  }
  server?.close()
  rmSync(profile, { recursive: true, force: true })
  console.log(
    JSON.stringify({
      output: out,
      checks: report.checks,
      errors: report.errors.length,
      success: report.success ?? false,
    }),
  )
}
