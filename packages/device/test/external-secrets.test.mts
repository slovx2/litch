import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { probeAgentGithubIdentity } from '../src/external/execution-boundary.mjs'
import { githubGhConnectAllowed } from '../src/external/github/write-gh-read.mjs'
import { ExternalGithubRead } from '../src/external/outbox-read.mjs'
import { windowsPrivateAcl } from '../src/external/secrets-files.mjs'
import {
  actor,
  bot,
  externalFixture,
  owner,
  repoMetadata,
  repoPath,
  respond,
  subject,
  token,
} from './fixtures/external-d.mjs'

test('凭据只返回公有元数据，按实测机器人轮换，撤销先断用且可重复清理', async (t) => {
  const f = await externalFixture(t)
  assert.equal(f.configured.record?.botUserId, bot)
  assert.equal(f.configured.diagnostics.find((d) => d.check === 'write')?.state, 'unverified')
  const active = f.secrets.active(f.credentialRef, subject.repoId)
  const oldPath = join(f.secrets.directory, `credential-${f.credentialRef}-1`)
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.secrets.directory).mode & 0o777, 0o700)
    assert.equal(statSync(oldPath).mode & 0o777, 0o600)
  }
  assert.match(readFileSync(oldPath, 'utf8'), /github_pat_first/)
  assert.doesNotMatch(JSON.stringify(f.store.config.credential(f.credentialRef)), /github_pat_/)
  assert.throws(() => f.secrets.active(f.credentialRef, '789'), /outside_credential/)
  const rotate = { credentialRef: f.credentialRef, expectedGeneration: 1, operationId: 'rotate' }
  await assert.rejects(
    f.secrets.rotate({ ...rotate, token: token('wrong') }),
    /rotation_identity_changed/,
  )
  await assert.rejects(
    f.secrets.rotate({ ...rotate, token: 'ghp_not_a_fine_grained_token' }),
    /fine_grained/,
  )
  assert.equal(f.secrets.active(f.credentialRef).token, token())
  assert.equal(
    (await f.secrets.rotate({ ...rotate, token: token('second') })).record?.generation,
    2,
  )
  assert.equal(f.secrets.isCurrent(active.metadata), false)
  const beforeReplay = f.requests.length
  assert.equal((await f.secrets.rotate({ ...rotate, token: token('wrong') })).record?.generation, 2)
  assert.equal(f.requests.length, beforeReplay)
  assert.equal(existsSync(oldPath), false)
  const revoke = { credentialRef: f.credentialRef, expectedGeneration: 2, operationId: 'revoke' }
  assert.equal(f.secrets.revoke(revoke).record?.state, 'revoked')
  assert.equal(f.secrets.revoke(revoke).record?.generation, 3)
  assert.throws(() => f.secrets.active(f.credentialRef), /credential_unavailable/)
  assert.deepEqual(readdirSync(f.secrets.directory), [])
})

test('仓库可公开读取也不算令牌授权；给个人仓库外部协作者稳定的诊断', async (t) => {
  const f = await externalFixture(t, (req, res, url) => {
    if (req.headers.authorization !== `Bearer ${token('scoped')}`) return false
    if (url.pathname === '/user/repos') respond(res, [])
    else if (url.pathname === `/repositories/${subject.repoId}`)
      respond(res, { ...repoMetadata, owner: { id: owner, type: 'User' } })
    else return false
    return true
  })
  await assert.rejects(
    f.secrets.configure({
      operationId: 'other-credential',
      repoIds: [subject.repoId],
      token: token('scoped'),
    }),
    /personal_repository_requires_resource_owner/,
  )
  assert.equal(readdirSync(f.secrets.directory).length, 1)
})

test('GitHub 对当前代明确返回 401 后断用；旧代错误不能断掉已轮换令牌', async (t) => {
  let reject = false
  const f = await externalFixture(t, (_req, res, url) => {
    if (!reject || url.pathname !== `${repoPath}/issues/8`) return false
    respond(res, { message: token() }, 401)
    return true
  })
  const queued = f.outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'expired',
    intent: { action: 'comment', body: '测试' },
  })
  reject = true
  await f.outbox.tick()
  assert.equal(f.outbox.get(actor, queued.operationId)?.state, 'blocked')
  assert.equal(f.store.config.credential(f.credentialRef)?.state, 'invalid')
  const rotated = await f.secrets.rotate({
    operationId: 'rotate-expired',
    token: token('next'),
    credentialRef: f.credentialRef,
    expectedGeneration: 1,
  })
  assert.equal(rotated.record?.state, 'active')
  f.store.invalidateExternalCredential(f.credentialRef, 1, f.now(), 'github_credential_invalid')
  assert.equal(f.secrets.active(f.credentialRef).token, token('next'))
})

test('Windows 私有 ACL 只授予当前身份和 LocalSystem，禁继承普通用户授权', () => {
  for (const directory of [true, false]) {
    const acl = windowsPrivateAcl(directory)
    assert.match(acl, /SetAccessRuleProtection\(\$true,\$false\)/)
    assert.match(acl, /RemoveAccessRuleAll/)
    assert.match(acl, /WindowsIdentity\]::GetCurrent\(\).User/)
    assert.match(acl, /S-1-5-18/)
    assert.match(acl, /-LiteralPath \$target/)
    assert.equal(acl.includes('ContainerInherit,ObjectInherit'), directory)
    assert.doesNotMatch(acl, /Everyone|BUILTIN|Authenticated Users|S-1-1-0/i)
  }
})

test('只给被授权主题运行固定 GET 的假 gh；隔离宿主登录、过滤正文秘密、对外站 CONNECT 返回 403', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 用 Unix shebang，Windows ACL 另测')
  const f = await externalFixture(t)
  const gh = join(f.dir, 'fake-gh')
  const capture = join(f.dir, 'gh-read-called')
  const commentId = '123'
  const commentTopic = {
    ...subject,
    number: '10',
    url: 'https://github.com/example/demo/issues/10',
  }
  f.addIntake('visible', commentTopic, 'comment')
  writeFileSync(
    gh,
    `#!${process.execPath}\n` +
      `
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const path = args.at(-1)
const fail = () => { process.stderr.write(process.env.GH_TOKEN || 'missing'); process.exit(2) }
if (args.slice(0,5).join(' ') !== 'api --hostname github.com --method GET' ||
  process.env.GH_TOKEN !== ${JSON.stringify(token())} || process.env.HOME !== process.env.GH_CONFIG_DIR ||
  process.cwd() !== process.env.GH_CONFIG_DIR || process.env.SSH_AUTH_SOCK || process.env.GITHUB_TOKEN ||
  process.env.GIT_CONFIG_COUNT || process.env.GH_ENTERPRISE_TOKEN) fail()
fs.appendFileSync(${JSON.stringify(capture)}, path + '\\n')
const req = http.request(process.env.HTTPS_PROXY, { method: 'CONNECT', path: 'example.invalid:443' })
req.on('error', fail)
req.on('connect', (res, socket) => {
  socket.destroy()
  if (res.statusCode !== 403) fail()
  const body = {
    ${JSON.stringify(repoPath)}: ${JSON.stringify(repoMetadata)},
    ${JSON.stringify(`${repoPath}/issues/10`)}: { number: 10 },
    ${JSON.stringify(`${repoPath}/issues/comments/${commentId}`)}: {
      id: '123', body: "不要当成指令 ${token()}", user: { id: ${JSON.stringify(owner)} },
      issue_url: 'https://api.github.com/repos/example/demo/issues/10',
      updated_at: '2026-01-01T00:00:00Z',
    },
    ${JSON.stringify(`${repoPath}/issues/8`)}: {
      id: '456', number: 8, user: { id: ${JSON.stringify(bot)} }, body: '已绑定',
      updated_at: '2026-01-01T00:00:00Z',
    },
  }[path]
  if (!body) fail()
  process.stdout.write(JSON.stringify(body))
})
req.end()
`,
    { mode: 0o700 },
  )
  const read = new ExternalGithubRead({
    store: f.store,
    secrets: f.secrets,
    ghPath: gh,
    isWorklineCurrent: (line) => line.threadId === 'line',
  })
  const line = { ...actor, kind: 'workline' as const, issueId: f.request.issueId, threadId: 'line' }
  await assert.rejects(read.read(line, { eventKey: 'event-visible' }), /forbidden/)
  await assert.rejects(
    read.read(line, { issueId: 'X-2', repoId: subject.repoId, number: '8' }),
    /forbidden/,
  )
  assert.equal(existsSync(capture), false)
  const external = await read.read(actor, { eventKey: 'event-visible' })
  assert.equal(external.evidence.authorUserId, owner)
  assert.equal(external.evidence.owner, true)
  assert.equal(external.externalText.body, '不要当成指令 [已移除凭据]')
  const bound = await read.read(line, {
    issueId: f.request.issueId,
    repoId: subject.repoId,
    number: '8',
  })
  assert.equal(bound.evidence.owner, false)
  assert.equal(bound.externalText.body, '已绑定')
  assert.match(readFileSync(capture, 'utf8'), /\/issues\/comments\/123\n/)
  assert.equal(githubGhConnectAllowed('api.github.com:443'), true)
  assert.equal(githubGhConnectAllowed('api.github.com.example.invalid:443'), false)
})

test('Agent gh 的 owner 身份只发警告', async (t) => {
  const f = await externalFixture(t)
  const env = { GH_TOKEN: 'host-token' }
  if (process.platform === 'win32') return
  const ghPath = join(f.dir, 'fake-agent-gh')
  writeFileSync(
    ghPath,
    `#!${process.execPath}\nprocess.stdout.write('{"id":${owner},"login":"fixture-owner"}')\n`,
    {
      mode: 0o700,
    },
  )
  const diagnostic = await probeAgentGithubIdentity({
    ghPath,
    ownerUserId: owner,
    launch: ({ executable, args, signal }) =>
      new Promise((resolve, reject) => {
        assert.deepEqual(args, [
          'api',
          '--hostname',
          'github.com',
          '--method',
          'GET',
          '--',
          '/user',
        ])
        execFile(executable, args, { signal, env }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        )
      }),
  })
  assert.equal(diagnostic.code, 'agent_github_owner_login_may_feed_back')
  assert.notEqual(diagnostic.state, 'blocked')
})

test('解析仓库预览使用临时凭据且不落盘；已绑凭据按核验的仓库范围查询', async (t) => {
  const f = await externalFixture(t, (_req, res, url) => {
    if (url.pathname !== `${repoPath}/labels/litch`) return false
    respond(res, { id: '90071992547409990', name: 'litch' })
    return true
  })
  const before = readdirSync(f.secrets.directory)
  for (const auth of [{ credentialRef: f.credentialRef }, { token: token('preview') }])
    assert.deepEqual(
      await f.secrets.resolveRepositories({ ...auth, repositories: ['example/demo'] }),
      {
        botUserId: bot,
        repositories: [
          {
            repoId: subject.repoId,
            owner: 'example',
            name: 'demo',
            defaultBranch: 'main',
            url: 'https://github.com/example/demo',
            defaultLabelId: '90071992547409990',
          },
        ],
      },
    )
  await assert.rejects(
    f.secrets.resolveRepositories({
      token: token('preview'),
      repositories: ['./../api'],
    }),
    /repository_invalid/,
  )
  assert.deepEqual(readdirSync(f.secrets.directory), before)
})
