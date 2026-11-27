// 真实 Electron、设备进程、SSH 与 Mac 命令；模型与状态目录均为隔离夹具。
import './require-ui-build.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ExternalStore } from '../../../packages/device/dist/packages/device/src/external-store.mjs'
import {
  ManagerStore,
  openManagerDatabase,
} from '../../../packages/device/dist/packages/device/src/manager-store.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../../../packages/device/dist/packages/protocol/src/manager.mjs'
import {
  managerClient,
  startManagerFixture,
  until,
} from '../../../scripts/client-fixture-manager-check.mjs'
import { withChromiumTestArgs } from '../../../third_party/litch-automation/scripts/chromium-test-args.mjs'

import { checkSignedMachine, seedFixturePhone } from './machine-phone-acceptance.mjs'

const require = createRequire(import.meta.url)
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const cleanup = []
let desktopLog
const t = { after: (fn) => cleanup.push(fn) }
const watch = (child) => {
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk
    })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGTERM')
    await exited
  })
  return () => output
}
const line = (log, prefix) =>
  log()
    .split('\n')
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length) ?? ''

// 只驱动自己创建的隐藏窗口；按钮用正式页面的事件处理。
async function runPage(config) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const wait = async (label, test) => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const value = test()
      if (value) return value
      await pause(50)
    }
    throw new Error(`${label}: ${document.body.innerText.slice(-4000)}`)
  }
  const port = await new Promise((resolve) => {
    const opened = (event) => {
      if (event.data?.type !== 'litch:core-port' || !event.ports[0]) return
      window.removeEventListener('message', opened)
      resolve(event.ports[0])
    }
    window.addEventListener('message', opened)
    window.litchShell.requestCorePort()
  })
  let serial = 2
  const pending = new Map()
  const devices = new Map()
  const turns = new Map()
  let sessionSub
  let live
  port.onmessage = ({ data }) => {
    if (data.t === 'snap') {
      if (data.id === sessionSub) {
        live = data.data
        turns.clear()
        for (const turn of live.turns) turns.set(turn.id, turn.status)
      } else for (const device of data.data.devices ?? []) devices.set(device.id, device)
    }
    if (data.t === 'delta') {
      for (const op of data.ops) {
        if (op.op === 'device.upsert') devices.set(op.device.id, op.device)
        if (data.id !== sessionSub) continue
        if (op.op === 'turn.add') turns.set(op.turn.id, op.turn.status)
        if (op.op === 'turn.status') turns.set(op.turnId, op.status)
        if (op.op === 'turn.remove') turns.delete(op.turnId)
      }
    }
    if (data.t !== 'res') return
    const entry = pending.get(data.id)
    pending.delete(data.id)
    if (data.ok) entry?.resolve(data.result)
    else entry?.reject(new Error(JSON.stringify(data.error)))
  }
  port.start()
  port.postMessage({ t: 'sub', id: 1, topic: { kind: 'app' } })
  const command = (name, params) =>
    new Promise((resolve, reject) => {
      const id = ++serial
      pending.set(id, { resolve, reject })
      port.postMessage({ t: 'cmd', id, name, params })
    })
  window.machineCommand = (name, params) =>
    name === 'forgetFixturePhone'
      ? window.litchApprovals.forget(params.phoneId)
      : name === 'checkComputerFixture'
        ? window.machineCheck(params.threadId, params.app)
        : command(name, params)
  const deviceId = 'approval-fixture'
  await wait('Mac 和 SSH 都在线', () =>
    ['local', deviceId].every((id) => devices.get(id)?.connection === 'online'),
  )
  await command('device.tools.set', {
    deviceId,
    machine: true,
    ...(config.cu ? { computer: true } : {}),
    ...(config.site ? { browser: true } : {}),
  })
  console.log('MACHINE_READY')
  window.machineCheck = async (sessionId, fixtureApp) => {
    const selector = `[data-session="${sessionId}"] .ss-row`
    ;(await wait('经理行', () => document.querySelector(selector)))?.click()
    sessionSub = ++serial
    port.postMessage({ t: 'sub', id: sessionSub, topic: { kind: 'session', deviceId, sessionId } })
    await wait(
      '会话输入区就绪',
      () =>
        live?.sessionId === sessionId &&
        live.live &&
        document.querySelector('.mg-chat textarea.cmp-text:not([disabled])'),
    )
    const send = async (text) => {
      const deadline = Date.now() + 25_000
      while (true) {
        try {
          return await command('session.send', { deviceId, sessionId, text })
        } catch (error) {
          // 唤醒回合刚显示结果时仍可能在收尾；只有设备明确拒绝的回合才重新提交。
          if (!String(error).includes('会话已有活动回合') || Date.now() >= deadline) throw error
          await pause(100)
        }
      }
    }
    // 工具结果可能先于回合完成。等到新回合结束再发下一条，避免夹具消息被保留为待发。
    const afterTurn = async (label, existing) =>
      wait(
        label,
        () =>
          [...turns].some(([id, status]) => !existing.has(id) && status === 'completed') &&
          ![...turns.values()].includes('running'),
      )
    const card = '[data-machine-deferred="true"]'
    if (config.site) {
      const access = `${card}[data-action="access"]`
      const request = async (path) => {
        const existing = new Set(turns.keys())
        await send(`本机网页：${config.site}/${path}`)
        return existing
      }
      // Claude Code 的夹具模型会原样回显收到的唤醒事件。
      const background = () => document.body.innerText.split('<litch-background-completed>').length
      const approve = async (choice) => {
        const button = await wait('内置浏览器站点卡', () =>
          document.querySelector(`${access} [data-option="${choice}"]`),
        )
        if (!button.closest(access).innerText.includes(config.site))
          throw new Error('卡片没有显示正确的来源')
        button.click()
      }
      const first = await request('once')
      await wait(
        '原回合收到提交说明',
        () =>
          document.body.innerText.includes('Submitted an approval card for this target.') &&
          document.querySelector(access),
      )
      console.log('BROWSER_PENDING')
      await wait('确认原回合已经结束且没有网站流量', () => window.machinePermit)
      await afterTurn('首次申请回合完成', first)
      const before = background()
      const beforeWake = new Set(turns.keys())
      await approve('once')
      await wait(
        '单次批准唤醒原会话',
        () =>
          background() > before &&
          document.body.innerText.includes('You may now retry the same operation.'),
      )
      await afterTurn('单次批准的唤醒回合完成', beforeWake)
      const retry = await request('once')
      await wait('重试确实加载测试网站', () =>
        document.body.innerText.includes('DEFERRED_SITE_ONCE'),
      )
      if (document.querySelector(access)) throw new Error('单次授权的重试仍然出卡')
      await afterTurn('重试回合完成', retry)
      const always = await request('always')
      const prior = background()
      await afterTurn('总是允许的申请回合完成', always)
      const beforeAlwaysWake = new Set(turns.keys())
      await approve('always')
      await wait('总是允许生效', () => background() > prior)
      await afterTurn('总是允许的唤醒回合完成', beforeAlwaysWake)
      await request('trusted')
      await wait('总是允许后一条直接加载', () =>
        document.body.innerText.includes('DEFERRED_SITE_TRUSTED'),
      )
      if (document.querySelector(access)) throw new Error('总是允许后仍然出卡')
      console.log('BROWSER_DONE')
      return
    }
    if (fixtureApp) {
      const access = `${card}[data-action="access"]`
      let asked = false
      const observer = new MutationObserver(() => {
        if (document.querySelector(access)) asked = true
      })
      observer.observe(document.body, { childList: true, subtree: true })
      try {
        await send(`本机应用：${fixtureApp} 1`)
        await wait('CU 普通应用直接返回无障碍树', () =>
          /Accessibility (?:tree|changes)/.test(document.body.innerText),
        )
        await send(`本机应用：${config.cuSelf} 2`)
        await wait('Litch 自身直接拒绝且说明须用户在场', () =>
          document.body.innerText.includes(
            '[litch:unattended] Using Computer Use on Litch itself requires the user to be present.',
          ),
        )
        if (asked || document.querySelector(access)) throw new Error('CU 不应出现异步审批卡')
      } finally {
        observer.disconnect()
      }
      console.log('CU_DONE')
      return
    }
    const execute = (value, filename, sleep = '') =>
      `本机：exec ${JSON.stringify({ command: `${sleep}printf '%s' ${value} > ${filename}; printf '%s' ${value}`, cwd: config.cwd })}`
    await send(execute('MACHINE_FIRST', config.first, 'sleep 3; '))
    await wait('对话卡', () => document.querySelector(card))
    await wait(
      '原回合结束且卡仍在',
      () =>
        document.body.innerText.includes('Submitted for approval') && document.querySelector(card),
    )
    if (!document.querySelector('[data-machine-approval]')) throw new Error('侧栏无待批准记号')
    console.log('MACHINE_PENDING')
    await wait('确认原回合已结束', () => window.machinePermit)
    document.querySelector(`${card} .timed-open`).click()
    ;(
      await wait('限时允许确认', () => document.querySelector(`${card} .req-timed .primary`))
    ).click()
    await wait('卡消失', () => !document.querySelector(card))
    await wait('本机操作限时条', () => document.querySelector('[data-timed="machine"]'))
    await wait('后台任务运行', () => document.querySelector('.bgbar'))
    await wait(
      '后台结果进入原会话',
      () =>
        document.querySelector('.turn [data-origin="backgroundTask"]') ||
        document.body.innerText.includes('The approved operation finished'),
    )
    await send(execute('MACHINE_SECOND', config.second))
    await wait(
      '授权内直接完成',
      () =>
        /output:\s+MACHINE_SECOND/.test(document.body.innerText) && !document.querySelector(card),
    )
    document.querySelector('.timedbar[data-timed="machine"] .x').click()
    await wait('撤销限时授权', () => !document.querySelector('[data-timed="machine"]'))
    await send(execute('MACHINE_STOPPED', config.stopped, 'sleep 15; '))
    ;(
      await wait('撤销后回到审批', () => document.querySelector(`${card} [data-option="once"]`))
    ).click()
    ;(await wait('单次批准进入后台', () => document.querySelector('.bgbar'))).click()
    ;(
      await wait('停止后台命令', () => document.querySelector('[data-status="running"] .bg-stop'))
    ).click()
    await wait('后台命令已停止', () => document.querySelector('[data-status="stopped"]'))
    if (document.querySelector('[data-timed="machine"]'))
      throw new Error('单次批准不能注册限时授权')
    const fileOperation = async (tool, args, output) => {
      await send(`本机：${tool} ${JSON.stringify(args)}`)
      ;(
        await wait(`文件卡 ${tool}`, () => document.querySelector(`${card} [data-option="once"]`))
      ).click()
      await wait(
        `后台结果 ${tool}`,
        () => !document.querySelector(card) && document.body.innerText.includes(output),
      )
    }
    await fileOperation(
      'write_file',
      {
        path: config.write,
        content: 'DEFERRED_FILE_CONTENT',
      },
      'Wrote',
    )
    await fileOperation('read_file', { path: config.read, length: 64 }, 'DEFERRED_READ_PROOF')
    await fileOperation('list_dir', { path: config.files }, 'DEFERRED_LIST_PROOF')
    await fileOperation(
      'copy',
      {
        from: { machine: 'session', path: config.sshSource },
        to: { machine: 'desktop', path: config.macDest },
      },
      'Copied 1 file',
    )
    await fileOperation(
      'copy',
      {
        from: { machine: 'desktop', path: config.macDest },
        to: { machine: 'session', path: config.sshDest },
      },
      `to session:${config.sshDest}.`,
    )
    console.log('MACHINE_DONE')
  }
}

try {
  const browserOnly = process.argv.includes('--browser-only')
  const cu = browserOnly ? undefined : process.env.LITCH_TEST_COMPUTER_APP
  const cuSelf = cu ? process.env.LITCH_TEST_COMPUTER_SELF_APP : undefined
  const wantsClaude = browserOnly || !!cu
  if (browserOnly) assert.ok(process.env.CHA_CLAUDE_CLI, '浏览器验收需要隔离 Claude CLI')
  let site = null
  const siteHits = []
  if (browserOnly) {
    const server = createServer((request, response) => {
      if (request.url !== '/once' && request.url !== '/trusted' && request.url !== '/always') {
        response.writeHead(404)
        response.end()
        return
      }
      siteHits.push(request.url)
      const title = `DEFERRED_SITE_${request.url.slice(1).toUpperCase()}`
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise((resolve) => server.close(resolve)))
    site = `http://unattended-approval.test:${server.address().port}`
  }
  if (cu)
    assert.ok(
      process.env.CHA_CLAUDE_CLI && process.env.LITCH_COMPUTER_USE_APP && cuSelf,
      'CU 验收需要隔离 Claude CLI、已授权的助手和带 Litch 包标识的隔离目标',
    )
  const local = await startManagerFixture(t, {})
  const child = spawn(
    process.execPath,
    [join(repo, 'scripts/client-ssh-fixture.mjs'), ...(wantsClaude ? ['--engines', 'claude'] : [])],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const sshLog = watch(child)
  const ssh = JSON.parse(await until('SSH 夹具', () => line(sshLog, 'LITCH_SSH_FIXTURE '), Boolean))
  const profile = join(local.root, 'approval-profile')
  mkdirSync(profile)
  seedFixturePhone(profile)
  writeFileSync(
    join(profile, 'devices.json'),
    JSON.stringify({
      localWire: null,
      remotes: [
        {
          id: 'approval-fixture',
          name: '审批 SSH 夹具',
          target: { kind: 'alias', alias: ssh.aliases.svc },
          wire: 'blue',
        },
      ],
    }),
  )
  const config = {
    cwd: local.root,
    first: join(local.root, 'approved'),
    second: join(local.root, 'timed'),
    stopped: join(local.root, 'stopped'),
    write: join(local.root, 'created-by-approval.txt'),
    read: join(local.root, 'read-test.txt'),
    files: join(local.root, 'list-test'),
    sshSource: join(ssh.work, 'copy-source.bin'),
    sshDest: join(ssh.work, 'copy-back.bin'),
    macDest: join(local.root, 'copy-on-mac.bin'),
    cu: !!cu,
    cuSelf,
    site,
  }
  const bytes = randomBytes(6_400_000)
  const digest = (value) => createHash('sha256').update(value).digest('hex')
  writeFileSync(config.sshSource, bytes)
  writeFileSync(config.read, 'DEFERRED_READ_PROOF')
  mkdirSync(config.files)
  writeFileSync(join(config.files, 'DEFERRED_LIST_PROOF'), '')
  const threadFile = join(profile, 'thread-id')
  const permissionFile = join(profile, 'click-approve')
  const commands = join(profile, 'commands')
  mkdirSync(commands)
  const bootstrap = join(profile, 'bootstrap.mjs')
  writeFileSync(
    bootstrap,
    `
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
${site ? "app.commandLine.appendSwitch('host-resolver-rules', 'MAP unattended-approval.test 127.0.0.1'); app.commandLine.appendSwitch('no-proxy-server');" : ''}
process.on('SIGTERM', () => app.quit());
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}; app.dock?.hide();
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (entry) => console.log(entry.message));
  win.webContents.once('did-finish-load', async () => {
    try {
      if (win.isVisible()) throw new Error('测试窗口没有保持隐藏');
      await win.webContents.executeJavaScript(${JSON.stringify(`(${runPage.toString()})(${JSON.stringify(config)})`)});
      const file = ${JSON.stringify(threadFile)};
      while (!existsSync(file)) await new Promise((done) => setTimeout(done, 50));
      const run = win.webContents.executeJavaScript('window.machineCheck(' + JSON.stringify(readFileSync(file, 'utf8')) + ')');
      run.catch(() => {});
      const approval = ${JSON.stringify(permissionFile)};
      while (!existsSync(approval)) await Promise.race([run, new Promise((done) => setTimeout(done, 50))]);
      await win.webContents.executeJavaScript('window.machinePermit = true');
      await run;
      let sequence = 0;
      while (!win.isDestroyed()) {
        const id = ++sequence;
        const request = ${JSON.stringify(join(profile, 'commands'))} + '/' + id + '.json';
        while (!existsSync(request)) await new Promise((done) => setTimeout(done, 50));
        const { name, params } = JSON.parse(readFileSync(request, 'utf8'));
        const code = 'window.machineCommand(' + JSON.stringify(name) + ',' + JSON.stringify(params) + ')';
        let response;
        try { response = { result: await win.webContents.executeJavaScript(code) }; }
        catch (error) { response = { error: String(error) }; }
        writeFileSync(request + '.result', JSON.stringify(response));
      }
    } catch (error) { console.error(error); app.exit(1); }
  });
});
await import(${JSON.stringify(pathToFileURL(join(repo, 'apps/desktop/dist/main.mjs')).href)});
`,
  )
  const desktop = spawn(
    process.env.LITCH_TEST_ELECTRON ?? require('electron'),
    withChromiumTestArgs([bootstrap]),
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: join(local.root, 'home'),
        TMPDIR: local.root,
        CODEX_HOME: join(local.root, 'cx'),
        LITCH_PROFILE: profile,
        LITCH_ENTRY: local.socket,
        LITCH_SSH_CONFIG: ssh.config,
        LITCH_REMOTE_CODEX: ssh.codex,
        LITCH_REMOTE_ADAPTER: ssh.adapter,
        LITCH_LANG: 'zh-CN',
        ...(process.env.LITCH_COMPUTER_USE_APP
          ? { LITCH_COMPUTER_USE_APP: process.env.LITCH_COMPUTER_USE_APP }
          : {}),
      },
    },
  )
  const log = watch(desktop)
  desktopLog = log
  await until('真实桌面连接', log, (output) => output.includes('MACHINE_READY'))
  const state = join(ssh.states.svc, 'device')
  const service = JSON.parse(readFileSync(join(state, 'service.json'), 'utf8'))
  const client = await managerClient(
    t,
    service.socket,
    [],
    [
      'machineApprovals',
      'machineApprovalSigning',
      'machineApprovalControls',
      'backgroundTasks',
      'timedApprovals',
    ],
  )
  const harness = browserOnly ? 'claude-code' : 'pi'
  const { data: models } = await client.call('model/list', { harness })
  const model = models.find((item) => item.isDefault) ?? models[0]
  assert.ok(model, '夹具没有模型')
  const { manager, threadId } = await client.call('litch/manager/create', {
    cwd: ssh.work,
    harness,
    name: browserOnly ? '无人值守内置浏览器验收' : '无人值守本机审批验收',
    ...(browserOnly ? { permission: ':workspace' } : {}),
    scope: '',
    rules: '',
    model: model.id,
    effort: model.defaultReasoningEffort ?? 'low',
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: MANAGER_DEFAULT_CONTACT,
  })
  const store = new ManagerStore(openManagerDatabase(state))
  try {
    const external = new ExternalStore(store)
    external.config.saveSource(
      {
        sourceId: 'machine-fixture',
        provider: 'github',
        enabled: true,
        credentialRef: 'missing',
        botUserId: '12',
        minRole: 'triage',
        interval: 3600,
        triggers: {
          mention: true,
          assignment: true,
          reviewRequest: false,
          label: false,
          labelIds: [],
        },
        repos: [
          {
            repoId: '42',
            owner: 'fixture',
            name: 'machine',
            url: 'https://github.com/fixture/machine',
            localRoot: ssh.work,
            allowedBase: ['main'],
            headNamespace: 'litch/',
          },
        ],
        routes: [],
        writePolicy: { comment: false, draftPr: false, status: false, managedPush: false },
        unattended: { autoNotify: true },
      },
      0,
      'setup-source',
      'fixture',
    )
    external.config.saveAssignment(
      { managerId: manager.id, identityId: null, repoIds: ['42'] },
      0,
      'setup-assignment',
      () => {},
    )
  } finally {
    store.close()
  }
  writeFileSync(threadFile, threadId)
  const pendingMarker = browserOnly ? 'BROWSER_PENDING' : 'MACHINE_PENDING'
  await until(
    '发起回合结束仍待批',
    log,
    (output) => output.includes(pendingMarker) || desktop.exitCode !== null,
  )
  assert.ok(log().includes(pendingMarker))
  if (browserOnly) assert.deepEqual(siteHits, [], '批准前不能访问测试站点')
  else assert.equal(existsSync(config.first), false, '批准前不能写入')
  await until(
    '审批卡不阻塞原回合',
    () => client.call('thread/read', { threadId, includeTurns: true }),
    ({ thread }) => thread.turns.at(-1)?.status === 'completed',
  )
  writeFileSync(permissionFile, '')
  if (browserOnly) {
    await until(
      '站点批准、唤醒和总是允许',
      log,
      (output) => output.includes('BROWSER_DONE') || desktop.exitCode !== null,
    )
    assert.match(log(), /BROWSER_DONE/)
    assert.deepEqual(siteHits, ['/once', '/trusted'], '批准授予重试权，不回放被拦下的访问')
    console.log(
      '真实隐藏 Mac：内置浏览器出站点卡时原回合已结束，站点没有流量；单次批准后唤醒并重试成功，本会话总是允许后直接访问。',
    )
  } else {
    await until(
      '后台执行、唤醒与限时直通',
      log,
      (output) => output.includes('MACHINE_DONE') || desktop.exitCode !== null,
    )
    assert.match(log(), /MACHINE_DONE/)
    await until('授权内实际执行', () => existsSync(config.second), Boolean)
    assert.equal(readFileSync(config.first, 'utf8'), 'MACHINE_FIRST')
    assert.equal(readFileSync(config.second, 'utf8'), 'MACHINE_SECOND')
    assert.equal(existsSync(config.stopped), false, '停止后命令未写入')
    assert.equal(readFileSync(config.write, 'utf8'), 'DEFERRED_FILE_CONTENT')
    assert.equal(digest(readFileSync(config.macDest)), digest(bytes))
    assert.equal(digest(readFileSync(config.sshDest)), digest(bytes))
    console.log(
      '真实隐藏 Mac：审批不阻塞，单次与限时批准、后台执行与唤醒、撤销和停止均通过；两向复制 6.4 MB 文件，SHA-256 一致',
    )
    let sequence = 0
    const onMac = async (name, params) => {
      const path = join(commands, `${++sequence}.json`)
      writeFileSync(path, JSON.stringify({ name, params }), { mode: 0o600 })
      const result = `${path}.result`
      const reply = await until(
        `Mac ${name}`,
        () => (existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : null),
        Boolean,
        name === 'checkComputerFixture' ? 110_000 : 30_000,
      )
      if (reply.error) throw new Error(reply.error)
      return reply.result
    }
    await checkSignedMachine({
      client,
      threadId,
      cwd: config.cwd,
      ssh,
      profile,
      onMac,
      copySource: config.sshSource,
    })
    if (cu) {
      const { data } = await client.call('model/list', { harness: 'claude-code' })
      const claude = data.find((entry) => entry.isDefault) ?? data[0]
      const created = await client.call('litch/manager/create', {
        cwd: ssh.work,
        harness: 'claude-code',
        name: '无人值守 CU 验收',
        scope: '',
        rules: '',
        model: claude.id,
        effort: claude.defaultReasoningEffort ?? 'low',
        permission: ':workspace',
        template: 'blank',
        firstTask: '',
        dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
        contact: MANAGER_DEFAULT_CONTACT,
      })
      const board = new ManagerStore(openManagerDatabase(state))
      try {
        new ExternalStore(board).config.saveAssignment(
          { managerId: created.manager.id, identityId: null, repoIds: ['42'] },
          0,
          'setup-cu-assignment',
          () => {},
        )
      } finally {
        board.close()
      }
      await onMac('checkComputerFixture', { threadId: created.threadId, app: cu })
      assert.match(log(), /CU_DONE/)
      console.log(
        '真实隐藏 Mac：项目内权限的无人值守 CU 直接读取普通应用，Litch 自身直接拒绝，均无审批卡',
      )
    }
  }
} catch (error) {
  if (desktopLog) console.error(desktopLog().slice(-10000))
  throw error
} finally {
  for (const finish of cleanup.reverse()) await finish()
}
