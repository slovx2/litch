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
import { checkPdf } from './pdf-checks.mjs'
import { pdfFixture } from './pdf-fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.local/pdf-preview-check', `${Date.now()}-${process.pid}`)
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
try {
  await build({
    configFile: join(root, 'packages/ui/vite.config.ts'),
    root: join(root, 'packages/ui'),
    logLevel: 'warn',
    build: {
      outDir: join(out, 'assets'),
      rollupOptions: { input: join(root, 'packages/ui/test/pdf/index.html') },
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
    report.browserLog = log
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
      allowUnsafeEvalBlockedByCSP: false,
    })
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      )
    return result.result.value
  }
  cdp.listeners.add((event) => {
    if (event.sessionId !== sessionId) return
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
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/test/pdf/index.html` })
  await checkPdf({ evaluate, call, report, out, pdfFixture })
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
