// 只由 check-file-preview-pdf-electron 启动，窗口不可见，不安装应用/技能、不连真实核心。
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow, protocol } from 'electron'
import { serveUiResource } from '../apps/desktop/src/ui-protocol.mts'
import { checkPdf } from './pdf-checks.mjs'
import { checkUiCsp } from './pdf-electron-ui-checks.mjs'
import { pdfFixture } from './pdf-fixtures.mjs'

const out = process.env.LITCH_PDF_CHECK_OUT
const assets = join(out, 'assets')
app.setPath('userData', process.env.LITCH_PDF_CHECK_PROFILE)
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
const report = { checks: [], errors: [], requests: [], responses: [], networkHits: 0, output: out }
void app.whenReady().then(async () => {
  app.setActivationPolicy('prohibited')
  app.dock?.hide()
  let window
  const trap = createServer((_req, res) => {
    report.networkHits++
    res.end('export const value = 1')
  })
  trap.on('upgrade', (_req, socket) => {
    report.networkHits++
    socket.destroy()
  })
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve))
  const port = trap.address().port
  const deadline = setTimeout(() => {
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    app.exit(1)
  }, 180_000)
  try {
    // 原生 API 探针没有 fetch/XHR 覆盖，验证的是响应头，而非我们的 JS 防误用。
    writeFileSync(
      join(assets, 'assets/pdf-worker-csp-probe.js'),
      `
const violations = [];
addEventListener('securitypolicyviolation', e => violations.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI }));
const rejected = f => Promise.resolve().then(f).then(() => false, () => true);
const fetchBlocked = await rejected(() => fetch('http://127.0.0.1:${port}/fetch'));
const socketBlocked = await new Promise(resolve => { try { const s = new WebSocket('ws://127.0.0.1:${port}/socket'); s.onopen = () => { s.close(); resolve(false) }; s.onerror = () => resolve(true); } catch { resolve(true) } });
const importBlocked = await rejected(() => import('http://127.0.0.1:${port}/module.js'));
const localImportBlocked = await rejected(() => import('./probe-module.js'));
const wasmAllowed = await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => true, () => false);
await new Promise(resolve => setTimeout(resolve, 100));
postMessage({ fetchBlocked, socketBlocked, importBlocked, localImportBlocked, wasmAllowed, violations });
`,
    )
    writeFileSync(join(assets, 'assets/probe-module.js'), 'export const value = 1')
    protocol.handle('app', async (request) => {
      const response = await serveUiResource(assets, request)
      report.responses.push({
        url: request.url,
        csp: response.headers.get('Content-Security-Policy'),
      })
      writeFileSync(join(out, 'progress.json'), JSON.stringify(report, null, 2))
      return response
    })
    window = new BrowserWindow({
      width: 1000,
      height: 800,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    assert(!window.isVisible() && !window.isFocused())
    // Electron 未导航的隐藏窗口尚无 renderer；先载入，再启用调试协议域。
    await window.loadURL('app://ui/test/pdf/index.html')
    window.webContents.debugger.attach('1.3')
    const call = (method, params = {}) => window.webContents.debugger.sendCommand(method, params)
    const evaluate = async (expression) => {
      const result = await Promise.race([
        call('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: false,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Evaluate timeout: ${expression.slice(0, 100)}`)),
            15000,
          ),
        ),
      ])
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    window.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Runtime.exceptionThrown') report.errors.push(params.exceptionDetails)
      if (method === 'Network.requestWillBeSent') report.requests.push(params.request.url)
    })
    await call('Runtime.enable')
    await call('Network.enable')
    await call('Page.enable')
    console.log('PDF Electron page loaded')
    const worker = await evaluate(`new Promise((resolve, reject) => {
      const w = new Worker('app://ui/assets/pdf-worker-csp-probe.js', {type: 'module'});
      w.onmessage = e => { w.terminate(); resolve(e.data) };
      w.onerror = e => { w.terminate(); reject(new Error(e.message)) };
    })`)
    report.worker = worker
    console.log('Worker CSP probe', worker)
    for (const key of [
      'fetchBlocked',
      'socketBlocked',
      'importBlocked',
      'localImportBlocked',
      'wasmAllowed',
    ])
      assert.equal(worker[key], true, key)
    assert(worker.violations.filter((v) => v.directive === 'connect-src').length >= 2)
    assert(
      worker.violations.filter(
        (v) => v.directive === 'script-src-elem' || v.directive === 'script-src',
      ).length >= 2,
    )
    assert.equal(report.networkHits, 0)
    report.checks.push(
      '真实 Electron app:// Worker 响应 CSP：fetch/WebSocket/远程及本地 import 拒绝，WASM 可编译',
    )
    // srcdoc 继承宿主脚本/连接限制，仍允许其静态 HTML、样式和文档画布。
    assert(
      await evaluate(`new Promise(resolve => {
      const f = document.createElement('iframe'); f.setAttribute('sandbox', '');
      f.srcdoc = '<style>body{font-size:16px}</style><p>静态文档</p>';
      f.onload = () => { f.remove(); resolve(true) }; document.body.append(f);
    })`),
    )
    await checkPdf({ evaluate, call, report, out, pdfFixture })
    await checkUiCsp({ window, evaluate, report })
    assert(!window.isVisible() && !window.isFocused())
    report.success = true
  } catch (error) {
    report.success = false
    report.failure = String(error)
  } finally {
    clearTimeout(deadline)
    window?.destroy()
    trap.close()
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({
        success: report.success,
        checks: report.checks,
        failure: report.failure,
        out,
      }),
    )
    app.exit(report.success ? 0 : 1)
  }
})
