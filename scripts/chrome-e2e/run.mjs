// 一条命令构建扩展/宿主，用正式 ChromeExecutor 驱动隔离 Chrome；CDP 仅验收侧观察和设置夹具。

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildChromeExtension } from '../../apps/desktop/scripts/build-chrome.mjs'
import { Cdp, until } from '../chrome-m0/cdp.mjs'
import { fixtures } from './fixtures.mjs'
import { remoteCheck } from './remote-check.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
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
if (!binary || !existsSync(binary) || !binary.includes('for Testing'))
  throw new Error(
    'Set LITCH_CHROME_BINARY to an installed Chrome for Testing binary. Daily Chrome is never used.',
  )
if (process.argv.includes('--shown') && process.env.LITCH_CHROME_GUI_SLOT !== 'approved')
  throw new Error('GUI checks need an approved foreground slot and LITCH_CHROME_GUI_SLOT=approved.')
const started = Date.now()
const work = mkdtempSync(join(tmpdir(), 'litch-chrome-e2e-'))
const outputBase = join(root, '.local/chrome-e2e')
const output = join(outputBase, `${started}-${process.pid}`)
mkdirSync(output, { recursive: true })
const report = { binary, checks: [], elapsedMs: 0, success: false }
let child, bridge, executor, cdp, site
let browserLog = ''
let cleanupTask
function cleanup() {
  cleanupTask ??= (async () => {
    executor?.dispose()
    cdp?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await bridge?.close()
    if (site) await new Promise((resolve) => site.server.close(resolve))
    rmSync(work, { recursive: true, force: true })
  })()
  return cleanupTask
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    report.success = false
    report.error = `Interrupted by ${signal}`
    void cleanup().finally(() => {
      report.elapsedMs = Date.now() - started
      writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
      writeFileSync(join(outputBase, 'report.json'), JSON.stringify({ ...report, output }, null, 2))
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  })
const check = async (name, fn) => {
  await fn()
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
try {
  const home = join(work, 'home'),
    profile = join(work, 'profile'),
    assets = join(work, 'assets')
  mkdirSync(home, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const identity = await buildChromeExtension(assets)
  writeFileSync(
    join(assets, 'test-wake.html'),
    '<!doctype html><title>Isolated worker lifecycle fixture</title>',
  )
  const nativeBinary = join(work, 'litch')
  const go = existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go'
  execFileSync(go, ['build', '-o', nativeBinary, './cmd/codex-harness-adapter'], {
    cwd: root,
    stdio: 'pipe',
  })
  await build({
    stdin: {
      contents:
        ['bridge', 'installer', 'executor']
          .map((name) => `export * from './apps/desktop/src/chrome-browser/${name}.mts'`)
          .join('\n') +
        `\nexport {createCore,reduceSession} from './packages/core/src/index.mts'; export {sshOpener} from './apps/desktop/src/transport-ssh.mts'; export {createClientToolHost} from './apps/desktop/src/client-tools/host.mts';`,
      resolveDir: root,
    },
    outfile: join(work, 'driver.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    alias: { '@litch/core': join(root, 'packages/core/src/index.mts') },
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
    },
    external: ['electron'],
    logLevel: 'warning',
  })
  const driver = await import(pathToFileURL(join(work, 'driver.mjs')))
  const { ChromeBridge, ChromeInstaller, ChromeExecutor } = driver
  const socketPath = join(work, 'bridge.sock')
  const installer = new ChromeInstaller({
    root: join(work, 'install'),
    assets,
    nativeBinary,
    socketPath,
    manifestDirectory: join(profile, 'NativeMessagingHosts'),
  })
  await installer.prepare()
  bridge = new ChromeBridge({
    socketPath,
    token: installer.token,
    extensionId: identity.id,
    version: identity.version,
  })
  await bridge.start()
  executor = new ChromeExecutor({ bridge, allowed: () => true })
  site = await fixtures()
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const debugPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  assert.notEqual(debugPort, 9333)
  child = spawn(
    binary,
    [
      ...(process.argv.includes('--shown') ? [] : ['--headless=new']),
      `--user-data-dir=${profile}`,
      '--enable-unsafe-extension-debugging',
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-proxy-server',
      '--site-per-process',
      '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1',
      '--window-size=1000,800',
      'about:blank',
    ],
    {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        TMPDIR: work,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  child.stderr.on('data', (data) => {
    browserLog = (browserLog + data).slice(-65536)
  })
  const version = await until(
    async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(),
    'Chrome startup',
  )
  const pids = execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${debugPort}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
  assert.deepEqual(pids, [String(child.pid)])
  report.version = version.Browser
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  // 和正式手动安装一样先开启开发者模式，否则 Chrome 会在 reload 时禁用未打包扩展。
  const settingsTarget = await cdp.call('Target.createTarget', { url: 'chrome://extensions/' })
  const settingsSession = (
    await cdp.call('Target.attachToTarget', { targetId: settingsTarget.targetId, flatten: true })
  ).sessionId
  await until(
    async () =>
      (
        await cdp.call(
          'Runtime.evaluate',
          { expression: '!!chrome.developerPrivate', returnByValue: true },
          settingsSession,
        )
      ).result?.value,
    'Extension settings API',
  )
  await cdp.call(
    'Runtime.evaluate',
    {
      expression: 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})',
      awaitPromise: true,
    },
    settingsSession,
  )
  await cdp.call('Target.closeTarget', { targetId: settingsTarget.targetId })
  const installed = await cdp.call('Extensions.loadUnpacked', {
    path: installer.extensionDirectory,
  })
  assert.equal(installed.id, identity.id)
  await until(() => bridge.instances().length === 1, 'Native Messaging handshake')
  const targetId = `chrome:${bridge.instances()[0].id}`
  const invocation = {
    id: 'e2e',
    namespace: 'litch_browser',
    callId: 'e2e',
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    device: { id: 'local', name: 'Isolated Mac', kind: 'local', target: null },
    harness: null,
    cwd: root,
  }
  const asks = []
  let answer = 'once'
  const context = {
    signal: new AbortController().signal,
    ask: async (ask) => {
      asks.push(ask)
      return answer
    },
  }
  let callSequence = 0
  const unique = () => `fixture-${++callSequence}`
  const call = (tool, args) =>
    executor.call({ ...invocation, callId: unique(), tool, arguments: args }, context)
  const text = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
  const success = async (tool, args) => {
    const result = await call(tool, args)
    assert.equal(result.success, true, text(result))
    return result
  }
  let tabId
  await check('固定 ID / Native Messaging / 正式 executor', async () => {
    assert.equal(identity.id, 'fakgembkgnmeknpaegnneneockbjhaai')
    await success('targets', {})
    const result = await success('navigate', { targetId, url: `${site.origin}/login`, keep: true })
    tabId = JSON.parse(text(result).split('\n')[0]).tabId
  })
  await check('来源审批 / 登录态 / 密码掩码', async () => {
    await success('navigate', { tabId, url: site.origin })
    const value = text(await success('snapshot', { tabId }))
    assert.match(value, /SESSION OK/)
    assert.doesNotMatch(value, /fixture-secret/)
    assert.equal(asks.filter((ask) => ask.kind === 'site').length, 1)
  })
  await check('真实 ref 点击与输入', async () => {
    const value = text(await success('snapshot', { tabId }))
    const ref = value.match(/button "0".*?\[ref=(e\d+)\]/)?.[1]
    assert.ok(ref, value)
    await success('click', { tabId, ref })
    assert.match(text(await success('snapshot', { tabId })), /button "1"/)
    const input = value.match(/textbox "Fixture input".*?\[ref=(e\d+)\]/)?.[1]
    assert.ok(input)
    await success('type', { tabId, ref: input, text: '中文 input', clear: true })
    assert.match(text(await success('snapshot', { tabId })), /中文 input/)
  })
  await check('重复 callId 不重复派发点击', async () => {
    const value = text(await success('snapshot', { tabId }))
    const ref = value.match(/button "1".*?\[ref=(e\d+)\]/)?.[1]
    assert.ok(ref)
    const repeated = { ...invocation, callId: unique(), tool: 'click', arguments: { tabId, ref } }
    const first = await executor.call(repeated, context)
    const second = await executor.call(repeated, context)
    assert.equal(first.success, true, text(first))
    assert.deepEqual(second, first)
    assert.match(text(await success('snapshot', { tabId })), /button "2"/)
  })
  await check('截图', async () => {
    const result = await success('screenshot', { tabId, format: 'png' })
    const image = result.contentItems.find((item) => item.type === 'inputImage')
    assert.ok(image)
    writeFileSync(join(output, 'page.png'), Buffer.from(image.imageUrl.split(',')[1], 'base64'))
  })
  await check('isolated world 公共光标 / 截图不含光标 / AX 无光标', async () => {
    const page = executor.pages.get(tabId)
    const target = (await cdp.call('Target.getTargets')).targetInfos.find(
      (target) => target.type === 'page' && target.url === `${site.origin}/`,
    )
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    const evaluate = async (expression, contextId) =>
      (
        await cdp.call(
          'Runtime.evaluate',
          { expression, contextId, returnByValue: true, awaitPromise: true },
          sessionId,
        )
      ).result.value
    assert.equal(await evaluate('typeof globalThis.__litchChromePointer'), 'undefined')
    assert.equal(
      await evaluate(`document.querySelector('[data-litch-chrome-pointer]')?.shadowRoot === null`),
      true,
    )
    assert.equal(
      await evaluate(
        `getComputedStyle(document.querySelector('[data-litch-chrome-pointer]')).pointerEvents`,
      ),
      'none',
    )
    const { frameTree } = await cdp.call('Page.getFrameTree', {}, sessionId)
    const { executionContextId } = await cdp.call(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frame.id, worldName: `litch-chrome-${page.grant.leaseId}` },
      sessionId,
    )
    const status = await evaluate('__litchChromePointer.status()', executionContextId)
    assert.equal(status.last.phase, 'completed')
    assert.equal(status.last.pressed, false)
    assert.equal(status.surface.kind, 'browserViewport')
    assert.equal(status.surface.generation, page.state.generation)
    const { cssVisualViewport: view } = await cdp.call('Page.getLayoutMetrics', {}, sessionId)
    const dpr = await evaluate('devicePixelRatio')
    const fit = Math.min(1, 1280 / Math.max(view.clientWidth, view.clientHeight, 1))
    const capture = async () =>
      (
        await cdp.call(
          'Page.captureScreenshot',
          {
            format: 'png',
            clip: {
              x: view.pageX,
              y: view.pageY,
              width: view.clientWidth,
              height: view.clientHeight,
              scale: fit / dpr,
            },
          },
          sessionId,
        )
      ).data
    const decorated = await capture()
    const result = await success('screenshot', { tabId, format: 'png' })
    const clean = result.contentItems
      .find((item) => item.type === 'inputImage')
      .imageUrl.split(',')[1]
    assert.equal(
      await evaluate(
        `getComputedStyle(document.querySelector('[data-litch-chrome-pointer]')).visibility`,
      ),
      'visible',
    )
    const snapshot = text(await success('snapshot', { tabId }))
    assert.doesNotMatch(snapshot, /litch.*pointer/i)
    await evaluate('__litchChromePointer.dispose()', executionContextId)
    const removed = await capture()
    assert.equal(clean, removed, 'Product screenshot equals the image with the renderer removed')
    assert.notEqual(decorated, clean, 'Raw browser screenshot includes the visible renderer')
    writeFileSync(join(output, 'pointer-visible.png'), Buffer.from(decorated, 'base64'))
    writeFileSync(join(output, 'pointer-excluded.png'), Buffer.from(clean, 'base64'))
    await cdp.call('Target.detachFromTarget', { sessionId })
    // 测试销毁了 world 内 renderer，重新认领后继续其余业务检查。
    await success('release', { tabId })
    const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url === `${site.origin}/`,
    )
    tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
  })
  await check('并行会话争用 / 令牌不可跨会话', async () => {
    const listed = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url === `${site.origin}/`,
    )
    const other = { ...invocation, threadId: 'competing-thread' }
    const denied = await executor.call(
      { ...other, callId: unique(), tool: 'claim', arguments: { claimToken: listed.claimToken } },
      context,
    )
    assert.equal(denied.success, false)
    const ownList = await executor.call(
      { ...other, callId: unique(), tool: 'tabs', arguments: { action: 'list', targetId } },
      context,
    )
    const ownToken = JSON.parse(text(ownList)).tabs.find(
      (tab) => tab.url === `${site.origin}/`,
    ).claimToken
    const busy = await executor.call(
      { ...other, callId: unique(), tool: 'claim', arguments: { claimToken: ownToken } },
      context,
    )
    assert.equal(busy.success, false)
    assert.match(text(busy), /busy/)
    await success('snapshot', { tabId })
  })
  await check('同时认领同一空闲标签只有一个成功', async () => {
    await success('release', { tabId })
    const contenders = [
      { ...invocation, threadId: 'race-one' },
      { ...invocation, threadId: 'race-two' },
    ]
    const tokens = await Promise.all(
      contenders.map(async (owner) => {
        const list = await executor.call(
          { ...owner, callId: unique(), tool: 'tabs', arguments: { action: 'list', targetId } },
          context,
        )
        return JSON.parse(text(list)).tabs.find((tab) => tab.url === `${site.origin}/`).claimToken
      }),
    )
    const claims = await Promise.all(
      contenders.map((owner, index) =>
        executor.call(
          { ...owner, callId: unique(), tool: 'claim', arguments: { claimToken: tokens[index] } },
          context,
        ),
      ),
    )
    assert.equal(claims.filter((result) => result.success).length, 1, JSON.stringify(claims))
    const winner = claims.findIndex((result) => result.success)
    const winnerTab = JSON.parse(text(claims[winner])).tabId
    assert.equal(
      (
        await executor.call(
          {
            ...contenders[winner],
            callId: unique(),
            tool: 'snapshot',
            arguments: { tabId: winnerTab },
          },
          context,
        )
      ).success,
      true,
    )
    await executor.call(
      { ...contenders[winner], callId: unique(), tool: 'release', arguments: { tabId: winnerTab } },
      context,
    )
    const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url === `${site.origin}/`,
    )
    tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
  })
  await check('拒绝来源后不重复询问', async () => {
    answer = 'decline'
    assert.equal((await call('navigate', { tabId, url: site.other })).success, false)
    const count = asks.length
    assert.equal((await call('navigate', { tabId, url: site.other })).success, false)
    assert.equal(asks.length, count)
    answer = 'once'
  })
  await check('未认领弹窗拒绝访问 / 审批后认领', async () => {
    await success('evaluate', { tabId, expression: `window.open('${site.other}/popup'); 'opened'` })
    const listed = await until(async () => {
      const tabs = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs
      return tabs.find((tab) => tab.url === `${site.other}/popup`)
    }, 'Popup created')
    assert.equal(listed.busy, false)
    assert.equal((await call('snapshot', { tabId: listed.claimToken })).success, false)
    assert.equal((await call('claim', { claimToken: listed.claimToken })).success, false)
    executor.turnEnded({
      deviceId: 'local',
      threadId: invocation.threadId,
      turnId: invocation.turnId,
    })
    invocation.turnId = 'second-turn'
    await until(
      async () =>
        JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.every(
          (tab) => !tab.busy,
        ),
      'Turn cleanup',
    )
    const tabs = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs
    const popup = tabs.find((tab) => tab.url === `${site.other}/popup`)
    const claimed = await success('claim', { claimToken: popup.claimToken })
    const popupId = JSON.parse(text(claimed)).tabId
    await success('snapshot', { tabId: popupId })
    assert.equal((await call('tabs', { action: 'close', tabId: popupId })).success, false)
    await success('release', { tabId: popupId })
    const original = tabs.find((tab) => tab.url === site.origin + '/')
    tabId = JSON.parse(text(await success('claim', { claimToken: original.claimToken }))).tabId
  })
  await check('跨来源 iframe 闸 / 重新审批', async () => {
    const moved = await call('navigate', { tabId, url: `${site.origin}/frames` })
    assert.equal(moved.success, false)
    assert.match(text(moved), /originNotApproved/)
    assert.equal((await call('screenshot', { tabId })).success, false)
    const list = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs
    const next = list.find((tab) => tab.url.endsWith('/frames'))
    tabId = JSON.parse(text(await success('claim', { claimToken: next.claimToken }))).tabId
    await success('snapshot', { tabId })
    await success('screenshot', { tabId })
  })
  await check('控制端 localhost / 远程来源调用上下文', async () => {
    invocation.device = {
      id: 'fixture-remote',
      name: 'Scripted remote',
      kind: 'ssh',
      target: 'fixture',
    }
    const result = await success('navigate', { targetId, url: site.origin })
    assert.match(text(result), /localhost are on the controller/)
    const remoteTab = JSON.parse(text(result).split('\n')[0]).tabId
    assert.equal((await call('snapshot', { tabId })).success, false)
    await success('snapshot', { tabId: remoteTab })
    executor.turnEnded({
      deviceId: invocation.device.id,
      threadId: invocation.threadId,
      turnId: invocation.turnId,
    })
    invocation.device = { id: 'local', name: 'Isolated Mac', kind: 'local', target: null }
  })
  await check('console 通过来源闸', async () => {
    await success('evaluate', { tabId, expression: `console.log('e2e console'); true` })
    await until(
      async () => text(await success('console', { tabId })).includes('e2e console'),
      'Console event',
    )
  })
  await check('手动登录冻结与重新认领', async () => {
    const priorAsk = context.ask
    context.ask = async (ask) => {
      if (ask.kind !== 'chromeSignIn') return priorAsk(ask)
      assert.equal((await call('snapshot', { tabId })).success, false)
      assert.equal((await call('tabs', { action: 'list', targetId })).success, false)
      return 'once'
    }
    await success('request_sign_in', { tabId, reason: 'Isolated sign-in acceptance' })
    assert.equal((await call('snapshot', { tabId })).success, false)
    context.ask = priorAsk
    await new Promise((resolve) => setTimeout(resolve, 200))
    const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url.endsWith('/frames'),
    )
    tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
    await success('snapshot', { tabId })
  })
  const workerSession = async () => {
    const found = (await cdp.call('Target.getTargets')).targetInfos.find(
      (target) =>
        target.type === 'service_worker' &&
        target.url.startsWith(`chrome-extension://${identity.id}/`),
    )
    assert.ok(found, 'Extension worker exists')
    return (await cdp.call('Target.attachToTarget', { targetId: found.targetId, flatten: true }))
      .sessionId
  }
  await check('缩放后截图与 ref 坐标', async () => {
    const sessionId = await workerSession()
    const nativeTab = executor.pages.get(tabId).grant.tabId
    await cdp.call(
      'Runtime.evaluate',
      { expression: `chrome.tabs.setZoom(${nativeTab}, 1.5)`, awaitPromise: true },
      sessionId,
    )
    await success('wait', { tabId, for: 'time', ms: 200 })
    await success('screenshot', { tabId })
    const value = text(await success('snapshot', { tabId }))
    const ref = value.match(/button "0".*?\[ref=(e\d+)\]/)?.[1]
    assert.ok(ref)
    await success('click', { tabId, ref })
    assert.match(text(await success('snapshot', { tabId })), /button "1"/)
    await cdp.call('Target.detachFromTarget', { sessionId })
  })
  await check('扩展 reload 重新握手 / 旧租约失效', async () => {
    const epoch = bridge.instances()[0].epoch
    const sessionId = await workerSession()
    await cdp
      .call('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, sessionId)
      .catch(() => {})
    try {
      await until(
        () => bridge.instances()[0]?.epoch && bridge.instances()[0].epoch !== epoch,
        'Extension reload handshake',
        10000,
      )
    } catch (error) {
      report.reloadTargets = (await cdp.call('Target.getTargets')).targetInfos.map(
        ({ type, url }) => ({ type, url }),
      )
      report.reloadInstances = bridge.instances()
      const diagnostic = await cdp.call('Target.createTarget', { url: 'chrome://extensions/' })
      const debugSession = (
        await cdp.call('Target.attachToTarget', { targetId: diagnostic.targetId, flatten: true })
      ).sessionId
      await new Promise((resolve) => setTimeout(resolve, 300))
      report.extensionDiagnostics = await cdp.call(
        'Runtime.evaluate',
        {
          expression:
            'new Promise(r=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}, r))',
          awaitPromise: true,
          returnByValue: true,
        },
        debugSession,
      )

      throw error
    }
    assert.equal((await call('snapshot', { tabId })).success, false)
    const list = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs
    const tab = list.find((tab) => tab.url.endsWith('/frames'))
    tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
    await success('snapshot', { tabId })
  })
  await check('worker 强停后的调试器清理与新握手', async () => {
    const nativeTab = executor.pages.get(tabId).grant.tabId
    const wake = await cdp.call('Target.createTarget', {
      url: `chrome-extension://${identity.id}/test-wake.html`,
    })
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: wake.targetId,
      flatten: true,
    })
    const versions = []
    const listener = (event) => {
      if (event.method === 'ServiceWorker.workerVersionUpdated')
        versions.push(...event.params.versions)
    }
    cdp.listeners.add(listener)
    try {
      await cdp.call('ServiceWorker.enable', {}, sessionId)
      const version = await until(
        () =>
          versions.find(
            (item) =>
              item.scriptURL === `chrome-extension://${identity.id}/background.js` &&
              item.runningStatus === 'running',
          ),
        'Worker version',
      )
      const epoch = bridge.instances()[0].epoch
      await cdp.call('ServiceWorker.stopWorker', { versionId: version.versionId }, sessionId)
      await cdp.call(
        'Runtime.evaluate',
        { expression: `chrome.runtime.sendMessage({type:'status'})`, awaitPromise: true },
        sessionId,
      )
      await until(
        () => bridge.instances()[0]?.epoch && bridge.instances()[0].epoch !== epoch,
        'Stopped worker handshake',
      )
      assert.equal((await call('snapshot', { tabId })).success, false)
      const worker = await workerSession()
      const targets = await cdp.call(
        'Runtime.evaluate',
        { expression: 'chrome.debugger.getTargets()', awaitPromise: true, returnByValue: true },
        worker,
      )
      assert.equal(
        targets.result.value.find((target) => target.tabId === nativeTab)?.attached,
        false,
      )
      await cdp.call('Target.detachFromTarget', { sessionId: worker })
      const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
        (tab) => tab.url.endsWith('/frames'),
      )
      tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
      await success('snapshot', { tabId })
    } finally {
      cdp.listeners.delete(listener)
      await cdp.call('Target.closeTarget', { targetId: wake.targetId })
    }
  })
  await check('Native Messaging 桥断线重连撤销旧租约', async () => {
    const epoch = bridge.instances()[0].epoch
    await bridge.close()
    await bridge.start()
    await until(
      () => bridge.instances()[0]?.epoch && bridge.instances()[0].epoch !== epoch,
      'Bridge reconnect',
    )
    assert.equal((await call('snapshot', { tabId })).success, false)
    const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url.endsWith('/frames'),
    )
    tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
    await success('snapshot', { tabId })
  })
  await check('输入前取消撤销租约且不点击', async () => {
    const value = text(await success('snapshot', { tabId }))
    const match = value.match(/button "(\d+)".*?\[ref=(e\d+)\]/)
    const count = match?.[1]
    const ref = match?.[2]
    assert.ok(ref)
    const controller = new AbortController()
    const pending = executor.call(
      { ...invocation, callId: unique(), tool: 'click', arguments: { tabId, ref } },
      { ...context, signal: controller.signal },
    )
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.success, false)
    assert.match(text(cancelled), /cancelled/)
    await until(() => !executor.pages.get(tabId)?.valid, 'Cancelled lease released')
    const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url.endsWith('/frames'),
    )
    tabId = JSON.parse(text(await success('claim', { claimToken: tab.claimToken }))).tabId
    assert.match(text(await success('snapshot', { tabId })), new RegExp(`button "${count}"`))
  })
  await check('停止操作撤权 / 同回合不可再次认领', async () => {
    executor.stop()
    await until(() => !executor.pages.get(tabId)?.valid, 'Stop revoked lease')
    assert.equal((await call('snapshot', { tabId })).success, false)
    const tab = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs.find(
      (tab) => tab.url.endsWith('/frames'),
    )
    const denied = await call('claim', { claimToken: tab.claimToken })
    assert.equal(denied.success, false)
    assert.match(text(denied), /cancelled/)
  })
  if (process.argv.includes('--remote'))
    await check('真实 SSH / 远程 Pi / 核心审批 / 控制端 Chrome', async () => {
      report.remote = await remoteCheck({ ...driver, executor, origin: site.origin })
    })
  report.success = true
} catch (error) {
  report.error ??= error.stack ?? String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await cleanup()
  report.elapsedMs = Date.now() - started
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputBase, 'report.json'), JSON.stringify({ ...report, output }, null, 2))
  if (!report.success) writeFileSync(join(output, 'chrome.log'), browserLog)
  console.log(
    `Chrome acceptance: ${report.success ? 'PASS' : 'FAIL'} in ${report.elapsedMs} ms; ${output}`,
  )
}
