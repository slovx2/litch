// 隔离 Linux 图形验收。两份 Docker 容器各有独立回环；启动后只用测试页和测试账号。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { checkRemoteChromeEngines } from './remote-device-engines.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeModule = join(repo, 'packages/device/dist/packages/device/src')
const { DeviceChromeRuntime } = await import(join(runtimeModule, 'remote-chrome-runtime.mjs'))
const { RemoteChromeRouter } = await import(join(runtimeModule, 'remote-chrome-routing.mjs'))
const { ClientToolRouter } = await import(join(runtimeModule, 'client-tools.mjs'))
const { DeclaredClientTools } = await import(
  join(runtimeModule, '../../shared/src/client-tool-executor.mjs')
)
const role = process.argv[2]
assert.ok(role === 'controller' || role === 'sessionDevice')
assert.equal(process.platform, 'linux')
assert.equal(process.env.DISPLAY, undefined, '设备服务不继承图形环境')
assert.ok(process.env.HOME.startsWith('/tmp/litch-chrome-fixture-'))
const home = process.env.HOME
const config = join(home, '.config')
const browser = process.env.LITCH_CHROME_BINARY
const binary = process.env.LITCH_ADAPTER_BINARY
assert.ok(browser && binary)
const stateDir = join(home, 'adapter/device')
const extension = join(repo, 'apps/desktop/dist/chrome-extension')
const origin = 'http://localhost:31770'
const scope = { harness: 'codex', threadId: 'fixture-session', turnId: 'fixture-turn' }
const runtime = new DeviceChromeRuntime(
  stateDir,
  '0.44.1',
  (status) => console.log(role, status.condition),
  console.error,
)
const router = new RemoteChromeRouter(runtime)
const allow = async () => 'once'
const server = createServer((_req, response) =>
  response.end(`<!doctype html><title>${role}</title>
  <h1>${role} loopback</h1><button onclick="this.textContent=Number(this.textContent)+1">0</button>
  <button onclick="document.getElementById('local-file').click()">Upload fixture</button>
  <input id="local-file" type="file" hidden onchange="this.files[0].text().then(text => document.getElementById('received').textContent = text)">
  <p id="received"></p>`),
)
const rejectedOrigin = 'http://127.0.0.1:31771'
const blockedServer = createServer((_req, response) => response.end('BLOCKED PAGE'))
const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
const wait = async (predicate, what) => {
  for (let i = 0; i < 150; i++) {
    const found = await predicate()
    if (found) return found
    await pause(100)
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const runCLI = (action) =>
  execFileSync(
    binary,
    [
      'chrome',
      action,
      '--root',
      repo,
      '--home',
      join(home, 'adapter'),
      ...(action === 'prepare' ? ['--user-data-dir', profile] : []),
    ],
    {
      env: { ...process.env, CHROME_CONFIG_HOME: config },
      encoding: 'utf8',
    },
  )
const handles = (answer) => {
  assert.equal(answer.success, true, JSON.stringify(answer))
  return JSON.parse(answer.contentItems[0].text.split('\n')[0])
}
const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
  stdio: 'inherit',
})
const logs = await mkdtemp(join(home, 'chrome-logs-'))
const profile = join(home, 'profile')
let chrome
function launch() {
  chrome = spawn(
    browser,
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      `--disable-extensions-except=${extension}`,
      ...(process.env.LITCH_FIXTURE_VERBOSE
        ? ['--enable-logging=stderr', '--vmodule=native_message*=2']
        : []),
      `--user-data-dir=${profile}`,
      `--load-extension=${extension}`,
      'about:blank',
    ],
    {
      env: { ...process.env, DISPLAY: ':99', CHROME_CONFIG_HOME: config },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  chrome.stderr.on('data', (bytes) => {
    if (process.env.LITCH_FIXTURE_VERBOSE) process.stderr.write(bytes)
  })
}
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill('SIGTERM')
  })
}
const close = async () => {
  await terminate(chrome)
  await terminate(xvfb)
  await runtime.close()
  server.close()
  blockedServer.close()
}
process.once('SIGTERM', () => void close().then(() => process.exit(0)))

try {
  // 验证原有登记保持原样，再移到专用的隔离配置目录继续测试。
  if (role === 'sessionDevice') {
    const dir = join(profile, 'NativeMessagingHosts')
    await mkdir(dir, { recursive: true })
    const manifest = join(dir, 'ai.litch.chrome.json')
    const other = JSON.stringify({
      name: 'ai.litch.chrome',
      path: '/fixture/another-owner',
      type: 'stdio',
      allowed_origins: ['chrome-extension://fakgembkgnmeknpaegnneneockbjhaai/'],
    })
    await writeFile(manifest, other)
    assert.throws(() => runCLI('prepare'), /already registered/)
    assert.equal(await readFile(manifest, 'utf8'), other)
    await runtime.refresh()
    assert.equal(runtime.status.condition, 'conflict')
    // 在同一个从未被 Chrome 使用过的夹具目录中换成新文件，保留冲突现场。
    const { rename } = await import('node:fs/promises')
    await rename(manifest, join(dir, 'conflict-evidence.json'))
  }
  assert.equal(JSON.parse(runCLI('prepare')).enabled, false)
  assert.equal(JSON.parse(runCLI('enable')).enabled, true)
  await wait(async () => {
    await runtime.refresh()
    return runtime.status.condition === 'waiting'
  }, 'prepared bridge to listen')
  await Promise.all([listen(server, 31770, '127.0.0.1'), listen(blockedServer, 31771, '127.0.0.1')])
  await pause(200)
  launch()
  await wait(() => runtime.status.condition === 'connected', 'Native Messaging handshake')
  assert.equal(process.env.DISPLAY, undefined)
  await writeFile(join(logs, 'handshake'), JSON.stringify(runtime.status))
  if (role === 'controller') {
    const api = createServer(async (req, res) => {
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const params = JSON.parse(Buffer.concat(chunks))
        const instances = runtime.instances
        const result = await runtime.call(
          scope,
          params,
          new Set(instances.map((i) => i.id)),
          new AbortController().signal,
          allow,
        )
        res.end(JSON.stringify(result))
      } catch (error) {
        res.statusCode = 500
        res.end(String(error))
      }
    })
    await listen(api, 31772, '0.0.0.0')
    console.log('CONTROLLER_READY')
    await new Promise((resolve) => api.once('close', resolve))
  } else {
    await checkDevice()
    await runtime.close()
    await checkRemoteChromeEngines({ repo, home, stateDir, binary, wait, terminate })
  }
} finally {
  await close()
}

async function checkDevice() {
  let requests = 0
  let decisions = 0
  let promptDecision = 'once'
  const sent = []
  const approvals = []
  const pendingAnswers = new Map()
  // 连接层提供连接身份，实际执行交给另一个网络命名空间中的真 Chrome。
  const peer = {
    id: 'controller-desktop',
    ready: true,
    remoteChrome: true,
    chromeTargetRouting: true,
    desktop: { hostname: 'controller-fixture' },
    clientToolNamespaces: new DeclaredClientTools(['litch_browser'], [], false, true),
    upstream: () => null,
    withdrawClientTool(id) {
      pendingAnswers.delete(id)
      approvals.push(['withdraw', id])
    },
    deliverClientTool(_harness, frame, answer) {
      if (frame.method === 'litch/remoteChrome/approval') {
        decisions++
        approvals.push(['ask', frame.params])
        const decide = (decision) =>
          answer({ result: { id: frame.params.id, nonce: frame.params.nonce, decision } })
        if (promptDecision !== null) queueMicrotask(() => decide(promptDecision))
        else pendingAnswers.set(frame.id, decide)
      } else {
        requests++
        void fetch('http://fixture-controller:31772', {
          method: 'POST',
          body: JSON.stringify(frame.params),
        })
          .then((reply) => reply.json())
          .then((result) => answer({ result }))
      }
      return frame.id
    },
  }
  // 用真实设备路由验证重复 callId、审批、旧连接和回合回收；线上的 Codex 请求在这里由夹具注入。
  const mux = new ClientToolRouter({
    remoteChrome: router,
    chromeHostLabel: () => runtime.status.hostLabel,
    graceMs: 5,
    log: console.log,
  })
  mux.join(peer)
  mux.turnBegan(scope.harness, scope.threadId, scope.turnId)
  mux.turnStarted(peer, scope.harness, scope.turnId)
  const source = {
    harness: scope.harness,
    available: true,
    reply: (text) => sent.push(JSON.parse(text)),
  }
  let sequence = 0
  const offer = (tool, args = {}, callId = `call-${++sequence}`) => {
    const id = `wire-${++sequence}`
    mux.offer(
      peer,
      source,
      {
        id,
        method: 'item/tool/call',
        params: { ...scope, callId, namespace: 'litch_browser', tool, arguments: args },
      },
      id,
    )
    return id
  }
  const call = async (tool, args, id) => {
    const wire = offer(tool, args, id)
    return (await wait(() => sent.find((r) => r.id === wire), tool)).result
  }
  const targets = handles(await call('targets')).targets
  const controller = targets.find((x) => x.location === 'controller').targetId
  const device = targets.find((x) => x.location === 'sessionDevice').targetId
  assert.notEqual(controller, device)
  const a = handles(await call('navigate', { targetId: controller, url: origin })).tabId
  const b = handles(await call('navigate', { targetId: device, url: origin })).tabId
  assert.notEqual(a, b)
  const snap = async (tabId) => {
    const reply = await call('snapshot', { tabId })
    assert.equal(reply.success, true, JSON.stringify(reply))
    return reply.contentItems[0].text
  }
  assert.match(await snap(a), /controller loopback/)
  const snapshot = await snap(b)
  assert.match(snapshot, /sessionDevice loopback/)
  const ref = snapshot.match(/button "0".*?\[ref=([^\]\s]+)\]/)?.[1]
  assert.ok(ref)
  const before = requests
  assert.equal(
    (await call('navigate', { targetId: controller, tabId: b, url: origin })).success,
    false,
  )
  assert.equal(
    (
      await call('run_actions', {
        actions: [
          { tool: 'click', arguments: { tabId: b, ref } },
          { tool: 'snapshot', arguments: { tabId: a } },
        ],
      })
    ).success,
    false,
  )
  assert.equal(requests, before)
  assert.match(await snap(b), /button "0"/)
  const inputArgs = { tabId: b, ref: (await snap(b)).match(/button "0".*?\[ref=([^\]\s]+)\]/)?.[1] }
  const clicked = await call('click', inputArgs, 'unique-action')
  assert.equal(clicked.success, true, JSON.stringify(clicked))
  const duplicate = offer('click', inputArgs, 'unique-action')
  await pause(200)
  assert.ok(!sent.some((result) => result.id === duplicate))
  assert.match(await snap(b), /button "1"/)
  promptDecision = 'decline'
  const denied = await call('navigate', { tabId: b, url: rejectedOrigin })
  assert.equal(denied.success, false, JSON.stringify(denied))
  assert.equal(requests, before)
  assert.equal(decisions, 2)
  const forUpload = await snap(b)
  assert.match(forUpload, /sessionDevice loopback/)
  const uploadRef = forUpload.match(/button "Upload fixture".*?\[ref=([^\]\s]+)\]/)?.[1]
  assert.ok(uploadRef)
  const localFile = join(home, 'device-only.txt')
  await writeFile(localFile, 'fixture bytes from the Linux session device')
  const upload = await call('upload', { tabId: b, ref: uploadRef, paths: [localFile] })
  assert.equal(upload.success, true, JSON.stringify(upload))
  assert.match(await snap(b), /fixture bytes from the Linux session device/)
  assert.equal(requests, before)
  promptDecision = null
  const signIn = offer('request_sign_in', {
    tabId: b,
    origin,
    reason: 'Fixture checks manual handoff',
  })
  await wait(() => pendingAnswers.size === 1, 'manual handoff prompt')
  assert.equal(approvals.at(-1)?.[1].kind, 'signIn')
  const paused = await call('snapshot', { tabId: b })
  assert.equal(paused.success, false)
  assert.match(paused.contentItems[0].text, /signingIn/)
  const [pendingId, decide] = pendingAnswers.entries().next().value
  pendingAnswers.delete(pendingId)
  decide('once')
  const completed = await wait(() => sent.find((reply) => reply.id === signIn), 'return control')
  assert.equal(completed.result.success, true)
  assert.equal((await call('ensure_claimed', { tabId: b })).success, true)
  const listed = handles(await call('tabs', { action: 'list', targetId: device }))
  assert.ok(listed.tabs.some((tab) => tab.url.includes('localhost') && tab.claimToken))
  const fresh = listed.tabs.find((tab) => tab.url.includes('localhost')).claimToken
  const reclaimed = handles(await call('claim', { claimToken: fresh })).tabId
  assert.equal((await call('claim', { claimToken: fresh })).success, false)
  promptDecision = null
  const pending = offer('navigate', { tabId: reclaimed, url: 'http://localhost:31771' })
  await wait(() => pendingAnswers.size === 1, 'pending site approval')
  assert.equal(JSON.parse(runCLI('disable')).enabled, false)
  await wait(() => !runtime.status.enabled, 'device Chrome disable')
  const stopped = await wait(
    () => sent.find((reply) => reply.id === pending),
    'cancelled site approval',
  )
  assert.equal(stopped.result.success, false)
  assert.equal(pendingAnswers.size, 0)
  assert.ok(approvals.some(([kind]) => kind === 'withdraw'))
  assert.equal((await call('click', inputArgs)).success, false)
  assert.equal(JSON.parse(runCLI('enable')).enabled, true)
  await wait(() => runtime.status.condition === 'connected', 'extension after enable')
  await terminate(chrome)
  await wait(() => runtime.status.condition === 'waiting', 'extension disconnect')
  assert.equal((await call('click', inputArgs)).success, false)
  launch()
  await wait(() => runtime.status.condition === 'connected', 'extension reconnect')
  assert.equal((await call('navigate', { targetId: device, url: origin })).success, false)
  mux.turnEnded(scope.harness, scope.turnId)
  assert.equal((await call('snapshot', { tabId: b })).success, false)
  console.log(
    'DUAL_CHROME_OK: localhost, handles, cross-end preflight, callId, denial, local upload, manual handoff, disable, reconnect, turn cleanup',
  )
}
