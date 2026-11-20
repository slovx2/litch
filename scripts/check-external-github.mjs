// 设备共同入口验收：真实设备库、会话树、WebSocket 和 gh 调用；只连接回环 GitHub。
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { DeviceServer } from '../packages/device/dist/packages/device/src/device.mjs'
import { bundledGithubCliPath } from '../packages/device/dist/packages/device/src/external/github/gh-version.mjs'
import { listenUnix } from '../packages/device/dist/packages/device/src/sockets.mjs'
import { FakeControl, managed } from '../packages/device/dist/packages/device/test/fake-control.mjs'
import { FakeEngine, resultOf } from '../packages/device/dist/packages/device/test/fake-engine.mjs'
import { TestClient } from '../packages/device/dist/packages/device/test/helpers.mjs'
import { brief, until } from '../packages/device/dist/packages/device/test/tree-kit.mjs'
import {
  EXTERNAL_METHOD as E,
  EXTERNAL_SOURCES_EXTENSION,
} from '../packages/device/dist/packages/protocol/src/external-sources.mjs'
import { parseSessionEvent } from '../packages/device/dist/packages/protocol/src/session-tree.mjs'
import { bot, oauth, owner, repo, scenario, web } from './external-github-mock.mjs'

const exec = promisify(execFile)
const coreExtensions = [
  'harness',
  'litchManager',
  'litchManagerIssues',
  'sessionTree',
  'clientTools',
]
const extensions = [...coreExtensions, EXTERNAL_SOURCES_EXTENSION]
const main = 'litch_manager'

test('设备 GitHub：授权、只读连接、待分拣、真实提醒、对账、X-n、凭据继承与 CI', {
  timeout: 30_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-'))
  const state = join(dir, 'state')
  const root = join(dir, 'repo')
  const runtimeRoot = join(dir, 'runtime')
  const socket = join(state, 'device.sock')
  const restricted = `${socket}.r`
  const clock = { now: Math.floor(Date.now() / 1000) }
  const mock = await scenario(t, clock)
  const pi = new FakeEngine('pi')
  let device
  let control
  let boot = 0
  let listeners = []
  const start = async () => {
    control = new FakeControl([managed('pi')])
    control.service = {
      pid: ++boot,
      startedAt: `start-${boot}`,
      version: '9.9.9',
      root,
      detached: true,
    }
    control.push()
    device = new DeviceServer({
      stateDir: state,
      upstreams: [{ id: 'pi', connect: pi.connector }],
      control,
      wrapUpReminder: false,
      importExisting: false,
      external: {
        runtimeRoot,
        deviceSocket: socket,
        fixture: { github: mock.origin, now: () => clock.now },
      },
      log: (line) => {
        if (process.env.LITCH_EXTERNAL_FIXTURE_LOG === '1') t.diagnostic(line)
      },
    })
    await device.external.agent.start()
    listeners = [
      await listenUnix(socket, (wire) => device.attach(wire, true)),
      await listenUnix(restricted, (wire) => device.attach(wire)),
    ]
  }
  const stop = async () => {
    await Promise.all(listeners.map((listener) => listener.close()))
    await device?.close()
    listeners = []
    device = undefined
  }
  t.after(async () => {
    await stop()
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(root)
  execFileSync('git', ['-C', root, 'init', '-q'])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', `${web}.git`])
  const gh = bundledGithubCliPath(runtimeRoot)
  mkdirSync(dirname(gh), { recursive: true })
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') console.log('gh version 2.102.0 (fixture)')
else if (args[0] === 'auth' && args[1] === 'login') {
  console.error('! First copy your one-time code: ABCD-EFGH')
  console.error('Open this URL to continue in your web browser: https://github.com/login/device')
} else if (args[0] === 'auth' && args[1] === 'token') console.log(${JSON.stringify(oauth)})
else if (args[0] === 'api' || args[0] === 'pr') {
  if (!process.env.GH_CONFIG_DIR) process.exit(6)
  const credential = /oauth_token: (\\S+)/.exec(fs.readFileSync(process.env.GH_CONFIG_DIR + '/hosts.yml', 'utf8'))?.[1]
  if (credential !== ${JSON.stringify(oauth)}) process.exit(6)
  if (args[0] === 'pr') {
    fetch(${JSON.stringify(`${mock.origin}/repos/example/demo/pulls`)}, {
      method: 'POST', headers: { authorization: 'Bearer ' + credential },
    }).then(async (response) => {
      if (!response.ok) process.exit(9)
      console.log((await response.json()).html_url)
    }).catch(() => process.exit(9))
  } else console.log('{"id":"${bot}","login":"litch-device"}')
} else process.exit(7)
`,
    { mode: 0o700 },
  )
  const hostBin = join(dir, 'bin')
  mkdirSync(hostBin)
  writeFileSync(join(hostBin, 'gh'), '#!/bin/sh\nprintf "system gh\\n"\n', { mode: 0o700 })

  await start()
  let flushed
  control.handlers['autostart.enable'] = ({ operationId }) => ({
    state: 'accepted',
    operationId,
    revision: 1,
  })
  control.handlers['autostart.release'] = () => ({})
  const handoff = new TestClient((wire) =>
    device.attach(
      {
        ...wire,
        send(text, afterReply) {
          wire.send(text)
          if (afterReply) flushed = afterReply
        },
      },
      true,
    ),
  )
  await handoff.initialize(['harness', 'litchDeviceAutostart'])
  assert.equal(
    (
      await handoff.call('litch/device/autostart/enable', {
        operationId: 'confirmed-flush',
        expectedRevision: 0,
      })
    ).state,
    'accepted',
  )
  assert.ok(!control.requests.some(({ method }) => method === 'autostart.release'))
  assert.equal(typeof flushed, 'function')
  flushed()
  await until(
    () => control.requests.some(({ method }) => method === 'autostart.release'),
    '自启在应答交给系统后确认',
  )
  handoff.close()
  const admin = await TestClient.overSocket(socket)
  const phone = await TestClient.overSocket(restricted)
  const plain = await TestClient.overSocket(socket)
  await Promise.all([
    admin.initialize(extensions),
    phone.initialize(extensions),
    plain.initialize(coreExtensions),
  ])
  assert.equal((await phone.call(E.accessGet, {})).triageInbox, false)
  assert.equal(
    (await phone.fails(E.identityAdd, { operationId: 'phone-not-admin', scopes: [] })).code,
    -32600,
  )
  assert.equal((await plain.fails(E.sourceList, {})).data.litch, 'extensionRequired')
  await admin.call(E.ownerSet, {
    expectedRevision: 0,
    operationId: 'set-owner',
    owner: {
      provider: 'github',
      userId: owner,
      loginCache: 'owner',
      profileUrl: 'https://github.com/owner',
      method: 'userId',
    },
  })
  const waiting = await admin.call(E.identityAdd, {
    operationId: 'device-code',
    scopes: ['repo', 'read:org', 'gist'],
  })
  assert.equal(waiting.state, 'waiting')
  assert.equal(waiting.userCode, 'ABCD-EFGH')
  let login
  await until(async () => {
    login = await admin.call(E.identityLoginGet, { loginId: waiting.loginId })
    return login.state !== 'waiting'
  }, '设备码核验完成')
  assert.equal(login.state, 'succeeded', JSON.stringify(login))
  assert.equal(login.result.identity.botUserId, bot)
  assert.ok(!JSON.stringify(admin.raw).includes(oauth))
  assert.ok(
    !phone.notifications.some(({ method }) => method === 'litch/external/identities/login/changed'),
  )
  const {
    repositories: [selected],
  } = await admin.call(E.identityRepositories, { repoId: repo.id })
  assert.equal(selected.repoId, repo.id)
  const { manager } = await admin.call('litch/manager/create', {
    cwd: root,
    harness: 'pi',
    model: null,
    effort: null,
    name: 'GitHub fixture',
    scope: '',
    rules: '',
    firstTask: '',
    template: 'blank',
    permission: null,
    dispatch: {
      harness: 'pi',
      model: null,
      effort: null,
      worktree: false,
      merge: 'manager',
      maxRunningLines: 2,
    },
    contact: { desktopNotification: false, unanswered: 'wait' },
  })
  const tid = manager.threadId
  await until(() => pi.running(tid), '经理首回合')
  pi.end(tid, 'completed', '等待外部请求')
  const source = {
    sourceId: 'fixture-repo',
    provider: 'github',
    enabled: true,
    credentialRef: selected.grants[0].credentialRef,
    botUserId: bot,
    triggers: { mention: true, assignment: true, reviewRequest: true, label: true, labelIds: [] },
    minRole: 'triage',
    interval: 120,
    routes: [],
    writePolicy: { comment: true, draftPr: true, status: false, managedPush: false },
    unattended: { autoNotify: true },
    repos: [
      {
        repoId: repo.id,
        owner: 'example',
        name: 'demo',
        url: web,
        localRoot: root,
        allowedBase: ['main'],
        headNamespace: 'litch/',
        pollIdentity: bot,
        immediateFeedbackLanguage: 'en',
      },
    ],
  }
  await admin.call(E.sourceUpsert, { source, expectedRevision: 0, operationId: 'add-repo' })
  await admin.call(E.managerAssignmentSet, {
    managerId: manager.id,
    identityId: bot,
    repoIds: [repo.id],
    expectedRevision: 0,
    operationId: 'assign-repo',
  })
  await until(
    async () =>
      (await admin.call(E.sourceGet, { sourceId: source.sourceId })).runtime.lastSuccessAt != null,
    '初始仓库轮询',
  )
  clock.now += 10
  mock.request(8)
  mock.request(9, 'outsider')
  clock.now += 10
  const preview = await admin.call(E.sourcePreview, { source })
  assert.ok(
    preview.matches.some(
      ({ subject, status }) => subject.number === '8' && status === 'pending_triage',
    ),
  )
  assert.deepEqual((await admin.call(E.inboxList, {})).entries, [], '预览不会写生产收件箱')
  clock.now += 121
  let intake
  await until(
    async () => {
      const { entries } = await admin.call(E.inboxList, {})
      intake = entries.find(
        ({ subject, status }) => subject.number === '8' && status === 'pending_triage',
      )
      return (
        !!intake &&
        entries.some(({ subject, status }) => subject.number === '9' && status === 'blocked') &&
        mock.states.created === 1
      )
    },
    '可信请求及权限不足请求入箱，首次反馈发出',
    6500,
  )
  assert.equal(intake.delivery.state, 'queued')
  assert.match([...mock.sent.values()][0].body, /queued/i)
  assert.equal(pi.running(tid), false)
  // 收件与确认是两次独立事件：断线重启后仍使用原回执查证，不新建另一条评论。
  await stop()
  clock.now += 180
  await start()
  const reconnect = await TestClient.overSocket(socket)
  await reconnect.initialize(extensions)
  await until(() => pi.running(tid), '重启后真实投递进入经理回合', 6000)
  const externalTurns = pi
    .sent('turn/start')
    .filter(
      ({ input }) => parseSessionEvent(input[0].text).event?.kind === 'manager-external-triage',
    )
  assert.equal(externalTurns.length, 1)
  assert.match(externalTurns[0].clientUserMessageId, /^external-/)
  await until(
    async () =>
      (await reconnect.call(E.inboxGet, { intakeId: intake.intakeId })).events.some(
        ({ delivery }) => delivery?.state === 'confirmed',
      ),
    '收件箱返回已投递',
  )
  await until(() => mock.states.updated === 1, '查证并更新原状态评论', 6500)
  assert.equal(mock.states.created, 1)
  assert.match([...mock.sent.values()][0].body, /I'm on it/i)

  const current = (await reconnect.call(E.inboxGet, { intakeId: intake.intakeId })).intake
  const accept = {
    intakeId: current.intakeId,
    expectedRevision: current.revision,
    idempotencyKey: 'take-8',
    title: 'Fixture X',
    body: 'Handle the GitHub request',
  }
  const taken = resultOf((await pi.callTool(tid, main, 'external_accept', accept))?.answer)
  assert.equal(taken.outcome, 'applied', JSON.stringify(taken))
  assert.equal(taken.mandate.issueId, 'X-1')
  const again = resultOf((await pi.callTool(tid, main, 'external_accept', accept))?.answer)
  assert.equal(again.mandate.issueId, 'X-1')
  const legacy = await TestClient.overSocket(socket)
  await legacy.initialize(coreExtensions)
  const issue = { managerId: manager.id, id: 'X-1' }
  assert.equal(
    (await reconnect.call('litch/manager/issue/read', issue)).issue.externalRefs.length,
    1,
  )
  assert.equal((await legacy.call('litch/manager/issue/read', issue)).issue.externalRefs, undefined)

  const line = resultOf(
    (
      await pi.callTool(tid, 'litch_sessions', 'start', {
        title: 'Fixture workline',
        ...brief('Open the fixture PR'),
        harness: 'pi',
        initiation: 'user_asked',
        wake_parent: false,
      })
    )?.answer,
  ).thread_id
  const commands = join(state, 'external-agent-gh', 'command')
  const runGh = (thread, args) =>
    exec(join(commands, 'gh'), args, {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${commands}:${hostBin}:${process.env.PATH}`,
        LITCH_DEVICE_GITHUB_COMMANDS: commands,
        LITCH_DEVICE_GITHUB_HARNESS: 'pi',
        PI_SESSION_ID: thread,
        LITCH_DEVICE_SOCKET: socket,
      },
    })
  const openPr = ['pr', 'create', '--repo', 'example/demo', '--draft']
  assert.equal((await runGh(line, openPr)).stdout.trim(), `${web}/pull/11`)
  assert.equal(mock.states.opened, 1)
  const latest = (await reconnect.call('litch/manager/issue/read', issue)).issue
  const linked = resultOf(
    (
      await pi.callTool(tid, main, 'external_link', {
        sourceId: source.sourceId,
        repoId: repo.id,
        number: '11',
        kind: 'pull_request',
        issueId: 'X-1',
        expectedIssueRevision: latest.revision,
      })
    )?.answer,
  )
  assert.equal(linked.outcome, 'applied', JSON.stringify(linked))
  pi.end(line, 'completed', 'Opened mock PR')
  pi.end(tid, 'completed', 'Linked mock PR')
  await until(() => !device.sessionTree.activeTurn(tid), '上一回合结束')
  clock.now += 10
  mock.completeRun(11)
  clock.now += 130
  await until(
    async () =>
      (await reconnect.call(E.inboxList, {})).entries.some(
        ({ kind, issueId }) => kind === 'ci' && issueId === 'X-1',
      ),
    'Actions 精确尝试入箱',
    6500,
  )
  const original = pi.handlers['turn/start']
  pi.handlers['turn/start'] = (params, connection) => {
    const result = original(params, connection)
    if (parseSessionEvent(params.input[0].text).event?.kind === 'manager-external-bound')
      throw new Error('夹具：引擎已记下消息，应答断开')
    return result
  }
  clock.now += 35
  await until(
    async () =>
      (await reconnect.call(E.inboxList, {})).entries.some(
        ({ kind, delivery }) => kind === 'ci' && delivery?.state === 'confirmed',
      ),
    'CI 提醒从引擎历史确认',
    6500,
  )
  assert.equal(
    pi
      .sent('turn/start')
      .filter(
        ({ input }) => parseSessionEvent(input[0].text).event?.kind === 'manager-external-bound',
      ).length,
    1,
  )
  const assignment = await reconnect.call(E.managerAssignmentGet, { managerId: manager.id })
  await reconnect.call(E.managerAssignmentSet, {
    managerId: manager.id,
    identityId: bot,
    repoIds: [repo.id],
    injectCredentials: false,
    expectedRevision: assignment.revision,
    operationId: 'disable-injection',
  })
  assert.equal((await runGh(line, openPr)).stdout.trim(), 'system gh')
  assert.equal(mock.states.created, 1, '设备机器人状态评论不得再次触发')
  assert.deepEqual(
    await control.onAsk('restart.prepare'),
    { prepared: 0 },
    '外部提醒不能生成计划恢复票',
  )
  const turns = pi.sent('turn/start').length
  await stop()
  await start()
  const final = await TestClient.overSocket(socket)
  await final.initialize(extensions)
  assert.equal(
    (await final.call(E.inboxList, {})).entries.find(({ kind }) => kind === 'ci').delivery.state,
    'confirmed',
  )
  assert.equal(pi.sent('turn/start').length, turns, '计划重启不能重放外部回合')
})
