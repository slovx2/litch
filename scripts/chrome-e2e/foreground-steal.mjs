// 不抢前台验收：隔离 CFT 的普通（非最小化）窗口留在别的前台应用后面，逐步执行常用 Chrome 工具，
// 每步核对 macOS 前台应用、Chrome 窗口是否被叠到前台应用之上、Chrome 内的活动标签与窗口焦点事件。
// 不连接日用 Chrome，不激活、隐藏或恢复任何用户应用。`--expect-fixed` 时任一步变化即失败。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildChromeExtension } from '../../apps/desktop/scripts/build-chrome.mjs'
import { Cdp, until } from '../chrome-m0/cdp.mjs'
import { launchBackgroundChrome } from './background-runtime.mjs'
import { fixtures } from './fixtures.mjs'
import { foregroundSteps } from './foreground-steal-steps.mjs'

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
const expectFixed = process.argv.includes('--expect-fixed')
const swift = (work, name) => {
  const executable = join(work, name)
  execFileSync('/usr/bin/xcrun', [
    'swiftc',
    fileURLToPath(new URL(`./${name}.swift`, import.meta.url)),
    '-o',
    executable,
  ])
  return executable
}

/** 前台监视：记录全部激活通知和 20ms 采样，按检查点切分，不在事后恢复焦点。 */
async function watchForeground(work) {
  const child = spawn(swift(work, 'foreground-watch'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const records = []
  createInterface({ input: child.stdout }).on('line', (line) => records.push(JSON.parse(line)))
  const next = (token) =>
    until(() => records.find((record) => record.token === token), `NSWorkspace ${token}`)
  const baseline = await next('ready')
  assert.ok(baseline.pid > 0, 'a frontmost user application must exist')
  let sequence = 0
  let cursor = records.length
  return {
    baseline,
    async mark() {
      const token = `mark-${++sequence}`
      child.stdin.write(`${token}\n`)
      await next(token)
      const slice = records.slice(cursor)
      cursor = records.length
      // 每段离开基线应用的时长（毫秒）；没回到基线的段记到检查点为止。
      const away = []
      let left = null
      for (const record of slice) {
        if (record.pid !== baseline.pid && left === null) left = record.at
        if (record.pid === baseline.pid && left !== null) {
          away.push(Math.round(record.at - left))
          left = null
        }
      }
      if (left !== null) away.push(Math.round(slice.at(-1).at - left))
      const pids = [...new Set(slice.map((record) => record.pid))].filter(
        (pid) => pid !== baseline.pid,
      )
      return { pids, away, back: slice.at(-1)?.pid === baseline.pid }
    },
    async close() {
      child.stdin.end()
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

const work = mkdtempSync('/tmp/litch-foreground-steal-')
let child, bridge, executor, cdp, site, foreground
try {
  const order = swift(work, 'window-order')
  foreground = await watchForeground(work)
  const home = join(work, 'home'),
    profile = join(work, 'profile'),
    assets = join(work, 'assets')
  mkdirSync(home)
  mkdirSync(profile)
  const identity = await buildChromeExtension(assets)
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
      resolveDir: root,
    },
    outfile: join(work, 'driver.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['electron'],
  })
  const { ChromeBridge, ChromeInstaller, ChromeExecutor, macForegroundKeeper } = await import(
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
  // 与桌面端相同的配置；--no-keeper 用于对照修复前的行为。
  executor = new ChromeExecutor({
    bridge,
    allowed: () => true,
    ...(process.argv.includes('--no-keeper') ? {} : { foreground: macForegroundKeeper() }),
  })
  site = await fixtures()
  child = await launchBackgroundChrome(
    binary,
    [
      '--no-startup-window',
      `--user-data-dir=${profile}`,
      `--load-extension=${installer.extensionDirectory}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
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
  assert.notEqual(port, '9333')
  assert.equal(
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim(),
    String(child.pid),
  )
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  let seq = 0
  const run = (tool, args) =>
    executor.call(
      {
        id: 'foreground-steal',
        namespace: 'litch_browser',
        callId: `fg-${++seq}`,
        threadId: 'foreground-fixture',
        turnId: 'foreground-turn',
        device: { id: 'local', name: 'Isolated Mac', kind: 'local', target: null },
        harness: null,
        cwd: root,
        tool,
        arguments: args,
      },
      { signal: new AbortController().signal, ask: async () => 'once' },
    )
  const windowOrder = () => JSON.parse(execFileSync(order, { encoding: 'utf8' }))
  // 复现模式：前台被抢后还给验收开始时的应用，后续各步才能各自判断。
  const restore = async () => {
    execFileSync(order, ['restore', String(foreground.baseline.pid)])
    await until(() => windowOrder().frontmost === foreground.baseline.pid, 'foreground restored')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await foreground.mark()
  }
  const prime = async () => {
    execFileSync(order, ['restore', String(child.pid)])
    await until(() => windowOrder().frontmost === child.pid, 'isolated Chrome activated once')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await restore()
  }
  const report = await foregroundSteps({
    restore,
    prime,
    only: process.argv
      .find((arg) => arg.startsWith('--only='))
      ?.slice(7)
      .split(','),
    cdp,
    run,
    bridge,
    identity,
    origin: site.origin,
    pid: child.pid,
    foreground,
    windowOrder,
    expectFixed,
  })
  console.log(JSON.stringify({ version: version.Browser, report }, null, 2))
  if (expectFixed) {
    const control = report.find((step) => step.step.startsWith('show'))
    if (control)
      assert.ok(control.problems.length, 'the show control must be seen taking the foreground')
    assert.deepEqual(
      report.filter((step) => step.scenario !== 'positive control' && step.problems.length),
      [],
      'Chrome tools must not take the foreground',
    )
  }
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
  await foreground?.close()
  rmSync(work, { recursive: true, force: true })
  console.log('CLEANUP isolated Chrome, bridge, server and temporary profile')
}
