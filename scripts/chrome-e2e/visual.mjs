// 已启动 UI 开发服务器时的 headless 组件视觉检查；不是正式 Chrome 安装验收。
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, until } from '../chrome-m0/cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
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
if (!binary) throw new Error('Set LITCH_CHROME_BINARY to Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-chrome-visual-'))
const output = join(root, '.local/chrome-visual')
mkdirSync(output, { recursive: true })
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
if (port === 9333) throw new Error('Forbidden debug port')
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
    '--window-size=1000,1500',
    'about:blank',
  ],
  { env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work }, stdio: 'ignore' },
)
let cdp
try {
  const version = await until(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    'Chrome ready',
  )
  if (
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim() !== String(child.pid)
  )
    throw new Error('Chrome PID mismatch')
  if (
    !execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'args='], {
      encoding: 'utf8',
    }).includes(`--user-data-dir=${work}/profile`)
  )
    throw new Error('Chrome isolated profile mismatch')
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find(
    (target) => target.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const read = async (expression) =>
    (
      await cdp.call(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      )
    ).result.value
  const cases = [
    { state: 'connected', skin: 'standard', theme: 'light' },
    { state: 'fresh', skin: 'retro', theme: 'dark' },
    { state: 'mismatch', skin: 'human', theme: 'light' },
    { state: 'connected', skin: 'standard', theme: 'light', width: 560 },
  ]
  for (const test of cases) {
    await cdp.call(
      'Emulation.setDeviceMetricsOverride',
      { width: test.width ?? 1000, height: 1500, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await cdp.call(
      'Page.navigate',
      { url: `http://127.0.0.1:5279/test/fixtures/chrome/index.html?state=${test.state}` },
      sessionId,
    )
    await until(
      () => read("!!document.querySelector('[data-chrome-settings]')"),
      'Chrome settings component',
    )
    await read(
      `window.__litchLook.set(${JSON.stringify({ skin: test.skin, theme: test.theme, lang: 'zh-CN' })})`,
    )
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const bounds = await read(
      "document.querySelector('[data-chrome-settings]').getBoundingClientRect().height",
    )
    if (bounds < 100) throw new Error('Chrome settings are not visible')
    const image = await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(
      join(output, `${test.skin}-${test.state}${test.width ? '-narrow' : ''}.png`),
      Buffer.from(image.data, 'base64'),
    )
    const overflow = await read(
      "[...document.querySelectorAll('.set-block,.req')].map(e=>({kind:e.className,width:e.clientWidth,scroll:e.scrollWidth})).filter(e=>e.scroll>e.width+1)",
    )
    if (overflow.length) throw new Error(`Horizontal overflow: ${JSON.stringify(overflow)}`)
  }
  console.log(output)
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  rmSync(work, { recursive: true, force: true })
}
