// 设备共同入口验收：真实设备库、会话树、WebSocket 和 gh 调用；只连接回环 GitHub。
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { DeviceServer } from '../packages/device/dist/packages/device/src/device.mjs'
import { managedGithubCliPath } from '../packages/device/dist/packages/device/src/external/github/gh-version.mjs'
import { listenDeviceEndpoints } from '../packages/device/dist/packages/device/src/sockets.mjs'
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

async function checkGithubFlow(t, notifications) {
  const dir = mkdtempSync(join(tmpdir(), 'lg-'))
  const state = join(dir, 'state')
  const root = join(dir, 'repo')
  const socket = join(state, 'device.sock')
  const proxySocket = `${socket}.r`
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
        deviceSocket: socket,
        fixture: { github: mock.origin, now: () => clock.now },
      },
      log: (line) => {
        if (process.env.LITCH_EXTERNAL_FIXTURE_LOG === '1') t.diagnostic(line)
      },
    })
    await device.external.agent.start()
    listeners = await listenDeviceEndpoints(socket, proxySocket, (wire, admin) =>
      device.attach(wire, admin),
    )
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
  const gh = managedGithubCliPath(state)
  mkdirSync(join(state, 'tools', 'github-cli'), { recursive: true, mode: 0o700 })
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
  const proxy = await TestClient.overSocket(proxySocket)
  // 直接接入非管理员会话，只验拒绝与通知裁剪；这不是 SSH 入口。
  const viewOnly = new TestClient(device)
  const plain = await TestClient.overSocket(socket)
  await Promise.all([
    admin.initialize(extensions),
    proxy.initialize([...extensions, 'litchDeviceAutostart']),
    viewOnly.initialize(extensions),
    plain.initialize(coreExtensions),
  ])
  const adminAccess = await admin.call(E.accessGet, {})
  const proxyAccess = await proxy.call(E.accessGet, {})
  const viewOnlyAccess = await viewOnly.call(E.accessGet, {})
  for (const key of ['configure', 'configureAutostart', 'triageInbox']) {
    assert.equal(adminAccess[key], true)
    assert.equal(proxyAccess[key], true)
    assert.equal(viewOnlyAccess[key], false)
  }
  assert.equal(
    (await viewOnly.fails(E.identityAdd, { operationId: 'not-admin', scopes: [] })).data.litch,
    'deviceAdminRequired',
  )
  assert.equal(
    (
      await proxy.call('litch/device/autostart/enable', {
        operationId: 'proxy-start',
        expectedRevision: 0,
      })
    ).state,
    'accepted',
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
  const loginRequest = {
    operationId: 'device-code',
    scopes: ['repo', 'read:org', 'gist'],
  }
  const waiting = await proxy.call(E.identityAdd, loginRequest)
  assert.equal((await admin.call(E.identityAdd, loginRequest)).loginId, waiting.loginId)
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
    !viewOnly.notifications.some(
      ({ method }) => method === 'litch/external/identities/login/changed',
    ),
  )
  viewOnly.close()
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
  await proxy.call(E.sourceUpsert, { source, expectedRevision: 0, operationId: 'add-repo' })
  await proxy.call(E.managerAssignmentSet, {
    managerId: manager.id,
    identityId: bot,
    repoIds: [repo.id],
    expectedRevision: 0,
    operationId: 'assign-repo',
  })
  assert.equal(
    (await admin.call(E.managerAssignmentGet, { managerId: manager.id })).identityId,
    bot,
  )
  const withoutScope = await admin.call(E.sourceGet, { sourceId: source.sourceId })
  assert.equal(withoutScope.readiness.collect.state, 'ok')
  assert.equal(withoutScope.source.enabled, true)
  assert.notEqual(withoutScope.runtime.state, 'paused')
  assert.ok(
    withoutScope.readiness.collect.diagnostics.some(
      ({ code }) => code === 'github_notifications_scope_required',
    ),
  )
  assert.equal(mock.notificationRequests.length, 0)
  if (notifications) {
    mock.enableNotificationScope()
    const addPermissions = await admin.call(E.identityAdd, {
      operationId: 'add-notification-scope',
      scopes: ['repo', 'read:org', 'gist', 'notifications'],
    })
    await until(async () => {
      const login = await admin.call(E.identityLoginGet, { loginId: addPermissions.loginId })
      return login.state === 'succeeded' && login.result.scopes.includes('notifications')
    }, '原机器人新增通知权限')
  }
  await until(
    async () =>
      (await admin.call(E.sourceGet, { sourceId: source.sourceId })).runtime.lastSuccessAt != null,
    '初始仓库轮询',
  )
  clock.now += 10
  await admin.call('litch/manager/update', {
    managerId: manager.id,
    rules: 'Check source evidence before replying.',
    name: 'Updated manager',
    scope: 'Loopback repository only',
  })
  await until(() => pi.running(tid), '规则更新进入经理回合')
  pi.end(tid, 'completed', '已采用规则')
  await until(() => !device.sessionTree.activeTurn(tid), '规则更新回合完成')
  assert.equal(
    (await admin.call(E.sourceGet, { sourceId: source.sourceId })).readiness.notify.state,
    'ok',
  )
  const originalIssue = mock.request(8)
  const issueBody = originalIssue.body
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
  assert.ok(originalIssue.updated_at > originalIssue.created_at, '回写已推进 issue 更新时间')
  assert.equal(originalIssue.body, issueBody, '原始 @ 正文没有编辑')

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

  // 第二条请求来自评论。夹具模拟 👀 推进原评论和议题的更新时间。
  if (pi.running(tid)) pi.end(tid, 'completed', 'Finished mock CI review')
  await until(() => !device.sessionTree.activeTurn(tid), 'CI 回合结束')
  clock.now += 10
  mock.request(12, 'owner', 'Request is in a comment')
  const comment = mock.comment(12, '401')
  const commentBody = comment.body
  clock.now += 131
  await until(
    () => mock.states.reactions === 1 && mock.states.created === 2,
    '原评论收到 👀，同议题的状态评论已创建',
    6500,
  )
  clock.now += 35 // 推过待分拣提醒的 30 秒合并窗口。
  let commentIntake
  await until(
    async () => {
      const { entries } = await final.call(E.inboxList, {})
      commentIntake = entries.find(
        ({ kind, subject, status, delivery }) =>
          kind === 'comment' &&
          subject.number === '12' &&
          status === 'pending_triage' &&
          delivery?.state === 'confirmed',
      )
      return !!commentIntake && mock.states.updated === 2
    },
    '原评论提醒已送达，同议题的状态评论已更新',
    6500,
  )
  assert.ok(comment.updated_at > comment.created_at, '反应已推进原评论更新时间')
  assert.equal(comment.body, commentBody)
  const commentRequest = (await final.call(E.inboxGet, { intakeId: commentIntake.intakeId })).intake
  const tookComment = resultOf(
    (
      await pi.callTool(tid, main, 'external_accept', {
        intakeId: commentRequest.intakeId,
        expectedRevision: commentRequest.revision,
        idempotencyKey: 'take-comment-12',
        title: 'Fixture comment',
        body: 'Handle the original comment.',
      })
    )?.answer,
  )
  assert.equal(tookComment.outcome, 'applied', JSON.stringify(tookComment))
  assert.equal(tookComment.mandate.issueId, 'X-2')

  // 当前状态轮询不依赖正文变化或关闭事件；此阶段关闭即时反馈，断言没有平台写入。
  const latestSource = (await final.call(E.sourceGet, { sourceId: source.sourceId })).source
  await final.call(E.sourceUpsert, {
    source: { ...source, repos: source.repos.map((r) => ({ ...r, immediateFeedback: false })) },
    expectedRevision: latestSource.revision,
    operationId: 'closed-intake-no-feedback',
  })
  clock.now += 10
  mock.request(13)
  mock.requestPull(14)
  mock.requestPull(15)
  clock.now += 131
  let pendingClosed
  await until(
    async () => {
      const page = await final.call(E.inboxList, { status: 'pending_triage' })
      pendingClosed = page.entries.filter(({ subject }) =>
        ['13', '14', '15'].includes(subject.number),
      )
      return pendingClosed.length === 3
    },
    'issue 与两个 PR 先进入待分拣',
    6500,
  )
  const writes = { ...mock.states }
  const starts = pi.sent('turn/start').length
  clock.now += 10
  mock.setSubjectState(13, 'closed')
  mock.setSubjectState(14, 'closed')
  mock.setSubjectState(15, 'closed', true)
  mock.setSubjectState(8, 'closed') // X-1 已绑定，继续遵循原有跟进策略。
  clock.now += 311
  await until(
    async () => {
      const page = await final.call(E.inboxList, { status: 'processed' })
      return pendingClosed.every(({ eventKey, subject }) =>
        page.entries.some(
          (entry) =>
            entry.eventKey === eventKey &&
            entry.reason === (subject.number === '15' ? 'external_merged' : 'external_closed'),
        ),
      )
    },
    '关闭和合并自动进入已处理',
    6500,
  )
  const pendingAfterClose = await final.call(E.inboxList, { status: 'pending_triage' })
  assert.ok(
    !pendingAfterClose.entries.some(({ subject }) => ['13', '14', '15'].includes(subject.number)),
  )
  for (const entry of pendingClosed) {
    const detail = await final.call(E.inboxGet, { intakeId: entry.intakeId })
    assert.equal(detail.intake.status, 'processed')
    assert.ok(
      device.external.store
        .audit(entry.subjectKey)
        .some(
          ({ action, reason }) => action === 'intake_obsoleted' && reason === detail.intake.reason,
        ),
    )
  }
  assert.deepEqual(mock.states, writes, '自动收尾不执行任何 GitHub 写入')
  assert.equal(pi.sent('turn/start').length, starts, '自动收尾不接单或启动经理回合')
  const boundAfterClose = await final.call(E.inboxGet, { intakeId: intake.intakeId })
  assert.equal(boundAfterClose.intake.issueId, 'X-1')
  assert.notEqual(boundAfterClose.intake.reason, 'external_closed')
  clock.now += 10
  mock.setSubjectState(13, 'open')
  mock.comment(13, '402')
  clock.now += 131
  await until(
    async () =>
      (await final.call(E.inboxList, { status: 'pending_triage' })).entries.some(
        ({ subject, intakeId }) =>
          subject.number === '13' &&
          intakeId !== pendingClosed.find((row) => row.subject.number === '13').intakeId,
      ),
    '重新打开后的新提及重新分拣',
    6500,
  )
  if (!notifications) {
    const fallback = await final.call(E.sourceGet, { sourceId: source.sourceId })
    assert.equal(fallback.readiness.collect.state, 'ok')
    assert.ok(
      fallback.readiness.collect.diagnostics.some(
        ({ code }) => code === 'github_notifications_scope_required',
      ),
    )
    assert.equal(
      mock.notificationRequests.length,
      0,
      '缺 scope 不调用通知 API，前面的 @ 入箱、提醒与接单全部经仓库流完成',
    )
    return
  }
  // 保留仓库历史积压，但评审请求、指派和提及都在一次通知轮询返回。
  mock.setHistory(2300)
  mock.setDiscovery(false)
  const configured = (await final.call(E.sourceGet, { sourceId: source.sourceId })).source
  await final.call(E.sourceUpsert, {
    source,
    expectedRevision: configured.revision,
    operationId: 'restore-feedback',
  })
  clock.now += 10
  mock.request(16)
  mock.requestPull(17, true)
  mock.assign(18)
  const beforeNotifications = mock.notificationRequests.length
  clock.now += 121
  await until(
    async () => {
      const { entries } = await final.call(E.inboxList, { status: 'pending_triage' })
      return ['16', '17', '18'].every((number) =>
        entries.some(({ subject }) => subject.number === number),
      )
    },
    '提及、评审请求、指派一轮入箱',
    6500,
  )
  assert.equal(mock.notificationRequests.length, beforeNotifications + 1)
  const collected = (await final.call(E.inboxList, { status: 'pending_triage' })).entries
  assert.deepEqual(
    collected
      .filter(({ subject }) => ['16', '17', '18'].includes(subject.number))
      .map(({ kind, sourceEventId }) => [kind, sourceEventId])
      .sort(),
    [
      ['assigned', '5018'],
      ['issue', '1016'],
      ['review_requested', '5017'],
    ],
  )
  await until(
    () => mock.states.created === writes.created + 3,
    '三个新请求各收到一条状态评论',
    6500,
  )
  mock.setDiscovery(true)
  clock.now += 311
  await until(
    async () =>
      (await final.call(E.sourceGet, { sourceId: source.sourceId })).runtime.lastSuccessAt ===
      clock.now,
    '仓库兜底再次核对',
    6500,
  )
  const deduped = (await final.call(E.inboxList, {})).entries
  for (const number of ['16', '17', '18'])
    assert.equal(deduped.filter(({ subject }) => subject.number === number).length, 1)
  assert.equal(mock.states.created, writes.created + 3, '仓库兜底和机器人通知不产生额外状态评论')
  assert.ok(
    mock.notificationRequests.every(
      ({ method, since, all }) => method === 'GET' && since && all === 'true',
    ),
  )
  assert.ok(
    mock.requests.every(({ method, path }) => !path.includes('/notifications') || method === 'GET'),
  )
  // 非限流的通知权限拒绝不能影响同凭据的仓库读取。
  mock.denyNotifications()
  clock.now += 121
  await until(
    async () =>
      (
        await final.call(E.sourceGet, { sourceId: source.sourceId })
      ).readiness.collect.diagnostics.some(
        ({ code }) => code === 'github_notifications_access_denied',
      ),
    '通知入口权限降级可见',
    6500,
  )
  // 通知刚由健康变成拒绝，尚未到原来的五分钟仓库核对点也要兜底。
  clock.now += 10
  mock.request(19)
  clock.now += 121
  await until(
    async () =>
      (await final.call(E.inboxList, { status: 'pending_triage' })).entries.some(
        ({ subject }) => subject.number === '19',
      ),
    '通知降级后下一轮仓库兜底仍可收新提及',
    6500,
  )
  mock.limitNotifications()
  clock.now += 121
  await until(
    async () => {
      const { readiness } = await final.call(E.sourceGet, { sourceId: source.sourceId })
      return (
        readiness.collect.state === 'ok' &&
        readiness.collect.diagnostics.some(
          ({ code }) => code === 'github_notifications_rate_limited',
        )
      )
    },
    'GitHub 通知限流在来源就绪状态中可见',
    6500,
  )
  assert.equal(
    (await final.call(E.sourceGet, { sourceId: source.sourceId })).coverage.find(({ stream }) =>
      stream.startsWith('notifications:'),
    ).backoffUntil,
    clock.now + 180,
  )
}

for (const notifications of [false, true])
  test(
    `设备 GitHub：${notifications ? '通知优先' : '缺通知 scope 时仓库兜底'}，授权、待分拣、反馈后接单、对账、X-n、凭据继承与 CI`,
    {
      timeout: 60_000,
    },
    (t) => checkGithubFlow(t, notifications),
  )
