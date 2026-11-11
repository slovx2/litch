// 隔离 headless Chrome + 正式核心，SSH 能力为本地替身。不操作日用浏览器。
// 运行 npm run client:check:remote-install；不读取真实 SSH 配置或密钥。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const binary = globSync(
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
)
  .sort()
  .at(-1)
if (!binary) throw Error('没有 Chrome for Testing')
const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'litch-install-browser-'))
const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
await new Promise((r) => server.close(r))
if (port === 9333) throw Error('禁用端口')
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    `--remote-debugging-port=${port}`,
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1500,1000',
    'about:blank',
  ],
  { env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work }, stdio: 'ignore' },
)
const uiReservation = createServer()
await new Promise((r) => uiReservation.listen(0, '127.0.0.1', r))
const uiPort = uiReservation.address().port
await new Promise((r) => uiReservation.close(r))
const ui = spawn(
  process.execPath,
  [
    join(root, 'packages/ui/node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ],
  { cwd: join(root, 'packages/ui'), stdio: 'ignore' },
)
let cdp
try {
  await until(async () => (await fetch(`http://127.0.0.1:${uiPort}/`)).ok, 'Vite')
  const version = await until(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    'ready',
  )
  if (
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim() !== String(child.pid)
  )
    throw Error('PID 不符')
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const read = async (expression) => {
    const result = await cdp.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const load = async (mode = '') => {
    await cdp.call(
      'Page.navigate',
      {
        url: `http://127.0.0.1:${uiPort}/test/remote-install-fixture.html?lang=zh-CN&mode=${mode}`,
      },
      sessionId,
    )
    await until(() => read("!!document.querySelector('.host input')"), '添加页')
    await read("document.querySelector('.host input').click()")
    await until(
      () => read("!!document.querySelector('[data-install-service] .cfail-cmd')"),
      '安装条件检查',
    )
  }
  await load()
  assert.deepEqual(await read('window.installFixture.calls'), ['inspect'], '确认前只读')
  await read("document.querySelector('[data-act=install-service]').click()")
  await until(() => read("!!document.querySelector('.confirm[open]')"), '确认卡')
  const confirmation = await read("document.querySelector('.confirm').innerText")
  assert.match(confirmation, /atlas-lab/)
  assert.match(confirmation, /1\.2\.3/)
  assert.match(confirmation, /--version '1\.2\.3'/)
  await read("document.querySelector('.confirm button.ghost').click()")
  assert.deepEqual(await read('window.installFixture.calls'), ['inspect'], '取消确认不安装')
  await read("document.querySelector('[data-act=install-service]').click()")
  await read("document.querySelector('.confirm-yes').click()")
  await until(() => read('window.installFixture.devices().length === 1'), '安装后保存设备')
  assert.deepEqual(await read('window.installFixture.calls'), [
    'inspect',
    'download',
    'install',
    'start',
    'clean',
  ])
  await load('failure')
  await read("document.querySelector('[data-act=install-service]').click()")
  await read("document.querySelector('.confirm-yes').click()")
  await until(
    () => read("document.querySelector('[data-install-service]')?.innerText.includes('HTTP 503')"),
    '远端失败原话',
  )
  assert.equal(await read('window.installFixture.devices().length'), 0, '失败不保存')
  assert.equal(
    await read(
      "document.querySelector('[data-install-service] code')?.innerText.includes('--version')",
    ),
    true,
  )
  for (const mode of ['fetch', 'system']) {
    await load(mode)
    assert.equal(await read("!!document.querySelector('[data-act=install-service]')"), false, mode)
    assert.equal(
      await read(
        "document.querySelector('[data-install-service] code')?.innerText.includes('1.2.3')",
      ),
      true,
    )
  }
  console.log(
    'PASS 首次安装确认卡、取消、安装启动连接后保存、下载失败不保存、无下载工具与 Windows 无按钮',
  )
} finally {
  cdp?.close()
  await Promise.all(
    [child, ui].map(
      (process) =>
        new Promise((resolve) => {
          if (process.exitCode !== null) {
            resolve()
            return
          }
          process.once('exit', resolve)
          process.kill('SIGTERM')
        }),
    ),
  )
  rmSync(work, { recursive: true, force: true })
}
