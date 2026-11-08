// 局部输入验收：隔离 CFT + 正式扩展/原生桥/执行器，不连接日用 Chrome。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildChromeExtension } from '../../apps/desktop/scripts/build-chrome.mjs'
import { Cdp, until } from '../chrome-m0/cdp.mjs'
import { backgroundInputChecks } from './background-input-check.mjs'
import { foregroundGuard, launchBackgroundChrome } from './background-runtime.mjs'
import { fixtures } from './fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = require('esbuild')
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
assert.ok(binary?.includes('for Testing'))
const shown = process.argv.includes('--shown')
if (shown && process.env.LITCH_CHROME_GUI_SLOT !== 'approved')
  throw Error('Four visible window states require LITCH_CHROME_GUI_SLOT=approved.')
const work = mkdtempSync('/tmp/litch-background-input-')
let child, bridge, executor, cdp, site, foreground
try {
  if (!shown) foreground = await foregroundGuard(work)
  const home = join(work, 'home'),
    profile = join(work, 'profile'),
    assets = join(work, 'assets')
  mkdirSync(home)
  mkdirSync(profile)
  const builder = process.env.LITCH_CHROME_EXTENSION_SOURCE
    ? (
        await import(
          pathToFileURL(
            join(
              process.env.LITCH_CHROME_EXTENSION_SOURCE,
              'apps/desktop/scripts/build-chrome.mjs',
            ),
          )
        )
      ).buildChromeExtension
    : buildChromeExtension
  const identity = await builder(assets)
  const nativeBinary = join(work, 'litch')
  execFileSync(
    process.env.LITCH_CHROME_GO ?? '/usr/local/go/bin/go',
    ['build', '-o', nativeBinary, './cmd/codex-harness-adapter'],
    { cwd: root, stdio: 'pipe' },
  )
  await build({
    stdin: {
      contents: ['bridge', 'installer', 'executor']
        .map((name) => `export * from './apps/desktop/src/chrome-browser/${name}.mts'`)
        .join('\n'),
      resolveDir: process.env.LITCH_CHROME_DRIVER_SOURCE ?? root,
    },
    outfile: join(work, 'driver.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['electron'],
  })
  const { ChromeBridge, ChromeInstaller, ChromeExecutor } = await import(
    pathToFileURL(join(work, 'driver.mjs'))
  )
  const socketPath = join(work, 'bridge.sock')
  const installer = new ChromeInstaller({
    root: join(work, 'install'),
    assets,
    nativeBinary,
    socketPath,
    claimLockDirectory: join(work, 'claims'),
    extensionIds: [identity.id],
    manifestDirectories: [join(profile, 'NativeMessagingHosts')],
  })
  await installer.prepare()
  bridge = new ChromeBridge({
    socketPath,
    token: installer.token,
    extensionIds: [identity.id],
    version: identity.version,
  })
  await bridge.start()
  executor = new ChromeExecutor({ bridge, allowed: () => true })
  site = await fixtures()
  child = await launchBackgroundChrome(
    binary,
    [
      '--no-startup-window',
      `--user-data-dir=${profile}`,
      `--load-extension=${installer.extensionDirectory}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-proxy-server',
      '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1',
    ],
    { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: work },
    profile,
  )
  const port = await until(
    () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0],
    'CFT port',
  )
  assert.equal(
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim(),
    String(child.pid),
  )
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  // 创建窗口唤醒扩展；默认最小化，不激活用户应用。
  const cover = await cdp.call('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
    background: true,
    windowState: 'minimized',
  })
  await until(() => bridge.instances().length === 1, 'native bridge')
  const targetId = `chrome:${bridge.instances()[0].id}`
  let seq = 0
  const run = (tool, args) =>
    executor.call(
      {
        id: 'background-input',
        namespace: 'litch_browser',
        callId: `input-${++seq}`,
        threadId: 'background-fixture',
        turnId: 'background-turn',
        device: { id: 'local', name: 'Isolated Mac', kind: 'local', target: null },
        harness: null,
        cwd: root,
        tool,
        arguments: args,
      },
      { signal: new AbortController().signal, ask: async () => 'once' },
    )
  const observations = await backgroundInputChecks({
    cdp,
    run,
    targetId,
    origin: site.origin,
    cover: cover.targetId,
    identity,
    shown,
    pid: child.pid,
    work,
    executor,
    foreground,
    expectFixed: process.argv.includes('--expect-fixed'),
    cases: process.argv
      .find((arg) => arg.startsWith('--cases='))
      ?.slice(8)
      .split(','),
  })
  console.log(JSON.stringify({ version: version.Browser, observations }, null, 2))
} finally {
  executor?.dispose()
  cdp?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  await bridge?.close()
  if (site) await new Promise((resolve) => site.server.close(resolve))
  try {
    await foreground?.check('background input and cleanup')
  } finally {
    await foreground?.close()
    rmSync(work, { recursive: true, force: true })
  }
  console.log('CLEANUP isolated Chrome, bridge, server and temporary profile')
}
