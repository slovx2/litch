// M0 真 Chrome 探针。只接受显式 CHROME_M0_BINARY；所有配置/清单在临时 HOME 内。
// 用法：CHROME_M0_BINARY=/绝对路径/Chrome-for-Testing node scripts/chrome-m0/run.mjs
// 默认 headless；只有明确获得前台验收时段后才可传 --shown。
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, until } from './cdp.mjs'
import { fixtures } from './fixtures.mjs'
import { lifecycleProbes } from './lifecycle-probes.mjs'
import { popupProbes } from './popup-probes.mjs'
import { probes } from './probes.mjs'

const binary = process.env.CHROME_M0_BINARY
const headless = !process.argv.includes('--shown')
const popupOnly = process.argv.includes('--popup-only')
const lifecycleOnly = process.argv.includes('--lifecycle-only')
if (!binary?.startsWith('/') || !binary.includes('for Testing')) {
  throw new Error('必须显式指定 Chrome for Testing，禁止启动日用 Chrome')
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const work = mkdtempSync(join(tmpdir(), 'litch-chrome-m0-'))
const home = join(work, 'home')
const profile = join(work, 'profile')
const extension = join(work, 'extension')
for (const path of [home, profile, extension]) mkdirSync(path, { recursive: true })
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = publicKey.export({ type: 'spki', format: 'der' })
const extensionId = [...createHash('sha256').update(key).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
  .join('')
writeFileSync(
  join(extension, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'Litch Chrome M0 isolated probe',
    version: '0.0.1',
    key: key.toString('base64'),
    background: { service_worker: 'extension.js', type: 'module' },
    web_accessible_resources: [{ resources: ['wake.html', 'wake.js'], matches: ['<all_urls>'] }],
    permissions: [
      'debugger',
      'nativeMessaging',
      'tabs',
      'storage',
      ...(popupOnly ? ['declarativeNetRequest'] : []),
    ],
  }),
)
const extensionSource = readFileSync(join(root, 'scripts/chrome-m0/extension.mts'), 'utf8')
  .replace('../../packages/protocol/src/automation-surface.mts', './automation-surface.js')
  .replace('./popup-extension.mts', './popup-extension.js')
writeFileSync(join(extension, 'extension.js'), stripTypeScriptTypes(extensionSource))
writeFileSync(
  join(extension, 'popup-extension.js'),
  stripTypeScriptTypes(readFileSync(join(root, 'scripts/chrome-m0/popup-extension.mts'), 'utf8')),
)
writeFileSync(
  join(extension, 'wake.html'),
  '<!doctype html><title>M0 worker wake</title><script src="wake.js"></script>',
)
writeFileSync(
  join(extension, 'wake.js'),
  'chrome.runtime.sendMessage({wake:true}).then(()=>document.title="M0 awake").catch(e=>document.title=String(e));',
)
writeFileSync(
  join(extension, 'automation-surface.js'),
  stripTypeScriptTypes(
    readFileSync(join(root, 'packages/protocol/src/automation-surface.mts'), 'utf8'),
  ),
)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const launcher = join(work, 'native-host')
writeFileSync(
  launcher,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'scripts/chrome-m0/native-host.mjs'))} "$@"\n`,
)
chmodSync(launcher, 0o700)
// 仅临时 HOME 内候选路径；不写实际用户的 NativeMessagingHosts。
for (const path of [
  join(profile, 'NativeMessagingHosts'),
  ...['Google/Chrome', 'Google/Chrome for Testing', 'Google/ChromeForTesting', 'Chromium'].map(
    (browser) => join(home, 'Library/Application Support', browser, 'NativeMessagingHosts'),
  ),
]) {
  mkdirSync(path, { recursive: true })
  writeFileSync(
    join(path, 'ai.litch.chrome_m0.json'),
    JSON.stringify({
      name: 'ai.litch.chrome_m0',
      description: 'Isolated probe',
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  )
}
const socketPath = join(work, 'bridge.sock')
let socket
let ready
let sequence = 0
const pending = new Map()
const bridge = createServer((incoming) => {
  socket = incoming
  let buffer = ''
  incoming.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      if (message.ready) {
        ready = message
        continue
      }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
    }
  })
})
await new Promise((accept) => bridge.listen(socketPath, accept))
chmodSync(socketPath, 0o600)
function rpc(op, args = {}) {
  const id = ++sequence
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`扩展超时：${op}`))
    }, 15000)
    pending.set(id, { resolve: accept, reject, timer })
    socket.write(`${JSON.stringify({ id, op, args })}\n`)
  })
}
const site = await fixtures()
const reservation = createServer()
await new Promise((accept) => reservation.listen(0, '127.0.0.1', accept))
const debugPort = reservation.address().port
await new Promise((accept) => reservation.close(accept))
if (debugPort === 9333) throw new Error('禁止端口 9333')
const child = spawn(
  binary,
  [
    ...(headless ? ['--headless=new'] : []),
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-proxy-server',
    '--disable-features=Translate',
    '--site-per-process',
    '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1',
    '--window-size=1000,800',
    'about:blank',
  ],
  {
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: work,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      LITCH_CHROME_M0_SOCKET: socketPath,
      LITCH_CHROME_M0_EXTENSION: extensionId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let browserLog = ''
child.stderr.on('data', (data) => {
  browserLog += data
})
const results = {
  work,
  binary,
  pid: child.pid,
  debugPort,
  extensionId,
  headless,
  checks: [],
}
let cdp
try {
  const version = await until(
    async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(),
    'Chrome 启动',
  )
  results.version = version.Browser
  const pids = execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${debugPort}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
  if (pids.length !== 1 || Number(pids[0]) !== child.pid)
    throw new Error(`调试端口 PID 不符：${pids}`)
  results.portOwnerVerified = true
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  await until(() => ready, 'Native Messaging 宿主连接')
  results.native = ready
  console.log(`M0 就绪：${version.Browser}；PID ${child.pid}；证据 ${work}`)
  await (popupOnly ? popupProbes : lifecycleOnly ? lifecycleProbes : probes)({
    rpc,
    cdp,
    site,
    results,
    work,
    getReady: () => ready,
    disconnect: () => socket?.destroy(),
  })
} catch (error) {
  results.fatal = String(error.stack ?? error)
  if (cdp) {
    const targets = await cdp.call('Target.getTargets')
    results.failureTargets = targets.targetInfos
    const worker = targets.targetInfos.find(
      (target) => target.url === `chrome-extension://${extensionId}/extension.js`,
    )
    if (worker) {
      const { sessionId } = await cdp.call('Target.attachToTarget', {
        targetId: worker.targetId,
        flatten: true,
      })
      results.workerState = await cdp.call(
        'Runtime.evaluate',
        { expression: 'globalThis.m0NativeError ?? "no native error"', returnByValue: true },
        sessionId,
      )
    }
  }
  console.error(results.fatal)
} finally {
  results.fixtureRequests = site.requests
  writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(join(work, 'chrome.log'), browserLog)
  cdp?.close()
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 2000).unref()
  socket?.destroy()
  bridge.close()
  site.server.close()
  site.server.closeAllConnections()
  for (const waiter of pending.values()) clearTimeout(waiter.timer)
  console.log(`证据保留：${join(work, 'results.json')}`)
}
if (results.fatal || results.checks.some((check) => check.status === 'fail')) process.exitCode = 1
setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref()
