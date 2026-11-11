// 不保留证据的真实生命周期验收：隐藏 Electron 与隔离 CFT，业务操作始终走正式执行器。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { withChromiumTestArgs } from '../../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from '../chrome-m0/cdp.mjs'
import { backgroundChecks } from './background-check.mjs'
import { foregroundGuard, launchBackgroundChrome, minimizeTarget } from './background-runtime.mjs'
import { inputChecks } from './input-check.mjs'

export async function chromeLifecycle({
  focusWindows = false,
  root,
  work,
  assets,
  nativeBinary,
  binary,
  site,
  build,
  check,
}) {
  const base = join(work, 'lc')
  mkdirSync(base)
  const hostFile = join(base, 'host.mjs')
  await build({
    entryPoints: [join(root, 'scripts/chrome-e2e/lifecycle-host.mts')],
    outfile: hostFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['electron'],
  })
  const copied = join(base, 'assets')
  cpSync(assets, copied, { recursive: true })
  // 只在隔离副本捕获真实工具栏回调，模拟用户点击；产品扩展不暴露恢复控制的方法。
  const background = join(copied, 'background.js')
  writeFileSync(
    background,
    'const addClick=chrome.action.onClicked.addListener.bind(chrome.action.onClicked);chrome.action.onClicked.addListener=(fn)=>{globalThis.__litchTestClick=fn;addClick(fn)};\n' +
      readFileSync(background, 'utf8'),
  )
  let profile = join(base, 'profile')
  mkdirSync(profile)
  let host,
    chrome,
    foreground,
    cdp,
    extensionDirectory,
    seq = 0
  const pending = new Map()
  const waiting = []
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, 'home'),
    CODEX_HOME: join(base, 'codex'),
    TMPDIR: work,
  }
  mkdirSync(env.HOME)
  const stop = async (child) => {
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  const startHost = async () => {
    const electron = createRequire(join(root, 'apps/desktop/package.json'))('electron')
    let ready
    let errors = ''
    host = spawn(electron, withChromiumTestArgs([hostFile, base, copied, profile, nativeBinary]), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    host.stderr.on('data', (data) => {
      errors = (errors + data).slice(-4000)
    })
    const lines = createInterface({ input: host.stdout })
    lines.on('line', (line) => {
      if (!line.startsWith('LITCH_LIFECYCLE ')) {
        errors = (errors + line).slice(-4000)
        return
      }
      const value = JSON.parse(line.slice(16))
      if (value.ready) {
        ready = value
        return
      }
      if (value.waiting) {
        waiting.push(value)
        return
      }
      const call = pending.get(value.id)
      if (call) {
        pending.delete(value.id)
        clearTimeout(call.timer)
        call.resolve(value)
      }
    })
    await until(
      () => {
        if (host.exitCode !== null) throw Error(`Hidden Electron exited: ${errors}`)
        return ready
      },
      'Hidden Electron Chrome host',
      30_000,
    ).catch((error) => {
      throw Error(`${error.message}: ${errors}`)
    })
    extensionDirectory = ready.extensionDirectory
  }
  const send = (message) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Error('Lifecycle call timed out'))
      }, 50_000)
      pending.set(id, { resolve, timer })
      host.stdin.write(`${JSON.stringify({ ...message, id })}\n`)
    })
  const connected = async () =>
    await until(async () => {
      const value = await send({ op: 'status' })
      return value.instances?.[0]
    }, 'Lifecycle native handshake')
  const startChrome = async () => {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    assert.notEqual(port, 9333)
    chrome = await launchBackgroundChrome(
      binary,
      [
        '--no-startup-window',
        `--user-data-dir=${profile}`,
        `--load-extension=${extensionDirectory}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-proxy-server',
        '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1',
      ],
      env,
      profile,
    )
    await foreground.check('headed Chrome background launch')
    const version = await until(
      async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
      'Lifecycle Chrome startup',
    )
    assert.equal(
      execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      }).trim(),
      String(chrome.pid),
    )
    assert.ok(
      execFileSync('/bin/ps', ['-p', String(chrome.pid), '-o', 'args='], {
        encoding: 'utf8',
      }).includes(`--user-data-dir=${profile}`),
    )
    cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    const settings = await cdp.call('Target.createTarget', {
      url: 'chrome://extensions/',
      newWindow: true,
      background: true,
      windowState: 'minimized',
    })
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: settings.targetId,
      flatten: true,
    })
    await minimizeTarget(cdp, settings.targetId)
    await until(
      async () =>
        (
          await cdp.call(
            'Runtime.evaluate',
            { expression: '!!chrome.developerPrivate', returnByValue: true },
            sessionId,
          )
        ).result?.value,
      'Lifecycle extension settings',
    )
    await cdp.call(
      'Runtime.evaluate',
      {
        expression: 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})',
        awaitPromise: true,
      },
      sessionId,
    )
    await cdp.call('Target.closeTarget', { targetId: settings.targetId })
    await connected()
    const userTab = await cdp.call('Target.createTarget', {
      url: site.origin,
      newWindow: true,
      background: true,
      windowState: 'minimized',
    })
    await minimizeTarget(cdp, userTab.targetId)
    assert.equal(
      (await cdp.call('Browser.getWindowForTarget', { targetId: userTab.targetId })).bounds
        .windowState,
      'minimized',
    )
    const attached = await cdp.call('Target.attachToTarget', {
      targetId: userTab.targetId,
      flatten: true,
    })
    await until(
      async () =>
        (
          await cdp.call(
            'Runtime.evaluate',
            {
              expression:
                'document.readyState === "complete" && !!document.querySelector("#count")',
              returnByValue: true,
            },
            attached.sessionId,
          )
        ).result?.value,
      'Lifecycle fixture loaded',
    )
    await cdp.call('Target.detachFromTarget', { sessionId: attached.sessionId })
  }
  const invoke = async (tool, args, delay = 0) => {
    const value = await send({ op: 'invoke', tool, args, delay })
    assert.equal(value.result?.success, true, JSON.stringify(value))
    assert.ok(
      value.asks.every((kind) => kind === 'site'),
      JSON.stringify(value.asks),
    )
    return { data: JSON.parse(value.result.contentItems[0].text), asks: value.asks }
  }
  const claim = async (delay = 0) => {
    const instance = await connected()
    const { data } = await invoke('tabs', { action: 'list', targetId: `chrome:${instance.id}` })
    const tab = data.tabs.find(
      (tab) => tab.url.replace(/\/$/, '') === site.origin.replace(/\/$/, ''),
    )
    assert.ok(tab, JSON.stringify(data))
    return invoke('claim', { claimToken: tab.claimToken }, delay)
  }
  const clickExtension = async () => {
    const info = (await cdp.call('Target.getTargets')).targetInfos.find(
      (t) => t.type === 'service_worker',
    )
    assert.ok(info)
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    })
    await cdp.call('Runtime.evaluate', { expression: 'globalThis.__litchTestClick()' }, sessionId)
    await cdp.call('Target.detachFromTarget', { sessionId })
  }
  try {
    foreground = await foregroundGuard(base)
    await startHost()
    await foreground.check('hidden Electron launch')
    await startChrome()
    await check('隐藏 Electron：网站审批真实等待 31 秒后成功，无实例卡和标签卡', async () => {
      const start = Date.now()
      const result = await claim(31_000)
      assert.ok(Date.now() - start >= 31_000)
      assert.deepEqual(result.asks, ['site'])
      assert.equal(waiting.at(-1)?.kind, 'site')
    })
    await inputChecks({
      targetId: `chrome:${(await connected()).id}`,
      origin: site.origin,
      run: async (tool, args) => (await send({ op: 'invoke', tool, args })).result,
      check: async (name, body) =>
        check(`Headed 最小化窗口 / ${name}`, async () => {
          await body()
          const targets = (await cdp.call('Target.getTargets')).targetInfos
          const worker = targets.find(
            (target) =>
              target.type === 'service_worker' && target.url.startsWith('chrome-extension://'),
          )
          assert.ok(worker)
          const attached = await cdp.call('Target.attachToTarget', {
            targetId: worker.targetId,
            flatten: true,
          })
          const background = await cdp.call(
            'Runtime.evaluate',
            {
              expression: `(async()=> (await chrome.tabs.query({})).filter(t=>/\\/(input|blocked-input)/.test(t.url||'')).map(t=>({active:t.active})))()`,
              awaitPromise: true,
              returnByValue: true,
            },
            attached.sessionId,
          )
          await cdp.call('Target.detachFromTarget', { sessionId: attached.sessionId })
          assert.ok(background.result.value.length > 0)
          assert.ok(
            background.result.value.every((tab) => tab.active === false),
            'agent tabs remain background tabs',
          )
          for (const target of (await cdp.call('Target.getTargets')).targetInfos.filter(
            (t) => t.type === 'page',
          ))
            assert.equal(
              (await cdp.call('Browser.getWindowForTarget', { targetId: target.targetId })).bounds
                .windowState,
              'minimized',
            )
          await foreground.check(`minimized headed: ${name}`)
        }),
    })
    if (focusWindows)
      await backgroundChecks({
        cdp,
        send,
        targetId: `chrome:${(await connected()).id}`,
        origin: site.origin,
        check,
        foreground,
        waitSignIn: () =>
          until(() => waiting.at(-1)?.kind === 'chromeSignIn', 'sign-in card waiting'),
      })
    await check('隔离 Chrome 重启，同会话按已保存网站许可直接认领', async () => {
      cdp.close()
      await stop(chrome)
      await startChrome()
      assert.deepEqual((await claim()).asks, [])
    })
    await check('隐藏 Electron 宿主重启，同会话无需再次批准 Chrome', async () => {
      await stop(host)
      await startHost()
      await connected()
      assert.deepEqual((await claim()).asks, [])
    })
    await check('用户停止跨 Chrome 与 Electron 重启保留，手动恢复后继续', async () => {
      await clickExtension()
      await until(async () => (await connected()).stopped, 'Stopped state')
      cdp.close()
      await stop(chrome)
      await stop(host)
      await startHost()
      await startChrome()
      const instance = await connected()
      assert.equal(instance.stopped, true)
      const stopped = await send({
        op: 'invoke',
        tool: 'tabs',
        args: { action: 'list', targetId: `chrome:${instance.id}` },
      })
      assert.equal(stopped.result.success, false)
      assert.match(stopped.result.contentItems[0].text, /userStopped.*click the Litch extension/)
      await clickExtension()
      await until(async () => !(await connected()).stopped, 'User resumed')
      assert.deepEqual((await claim()).asks, [])
    })
    await check('更换隔离扩展副本与 profile，instanceId 改变也只受网站许可约束', async () => {
      const before = await connected()
      cdp.close()
      await stop(chrome)
      await stop(host)
      profile = join(base, 'profile-copy')
      mkdirSync(profile)
      await startHost()
      await startChrome()
      assert.notEqual((await connected()).id, before.id)
      assert.deepEqual((await claim()).asks, [])
    })
  } finally {
    cdp?.close()
    await stop(chrome)
    await stop(host)
    for (const call of pending.values()) clearTimeout(call.timer)
    if (foreground) {
      try {
        await foreground.check('headed lifecycle cleanup')
        console.log('PASS NSWorkspace：headed 生命周期及清理全过程前台应用未变')
      } finally {
        await foreground.close()
      }
    }
  }
}
