import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  BUNDLED_GITHUB_CLI_VERSION,
  bundledGithubCliPath,
  locateSystemGithubConfig,
  resolveBundledGithubCli,
} from '../src/external/github/gh-version.mjs'
import { ExternalGithubOutbox } from '../src/external/outbox.mjs'
import { GithubGhAuthorizationService } from '../src/external/secrets-gh-authorization.mjs'
import {
  actor,
  externalFixture,
  owner,
  repoMetadata,
  repoPath,
  respond,
  subject,
  token,
} from './fixtures/external-d.mjs'

const oauthUser = '90071992547417771'
const otherRepo = {
  ...repoMetadata,
  id: '90071992547417772',
  full_name: 'someone/other',
  name: 'other',
  owner: { id: '90071992547417773', login: 'someone', type: 'User' },
}
const oauthToken = 'gho_oauth0123456789abcdefghijklmnopqrstuvwxyz'
const locked = ['gist', 'read:org', 'repo']
type Behavior = 'success' | 'wait' | 'expire' | 'garbled' | 'garbled-hang' | 'unsafe-url'
type Setup = {
  behavior?: Behavior
  userId?: string
  scopes?: string
  loginTimeoutMs?: number
  promptTimeoutMs?: number
  ownerConfirmationTimeoutMs?: number
}

async function fixture(t: TestContext, setup: Setup = {}) {
  const loginName = setup.userId === owner ? 'owner' : 'device-oauth'
  const f = await externalFixture(t, (req, res, url, data) => {
    if (req.headers.authorization === `Bearer ${token('advanced')}` && url.pathname === '/user') {
      respond(res, { id: oauthUser, login: 'advanced-bot', type: 'User' })
      return true
    }
    if (req.headers.authorization !== `Bearer ${oauthToken}`) return false
    if (url.pathname === '/user') {
      if (setup.scopes !== '')
        res.setHeader('X-OAuth-Scopes', setup.scopes ?? 'repo, read:org, gist, workflow')
      const id = setup.userId ?? oauthUser
      res.end(`{"id":${id},"type":"User","login":"${loginName}"}`)
    } else if (url.pathname === '/user/repos') {
      assert.equal(url.searchParams.get('affiliation'), 'owner,collaborator,organization_member')
      respond(res, [repoMetadata, otherRepo])
    } else if (url.pathname === `${repoPath}/issues/8/comments` && req.method === 'POST') {
      respond(
        res,
        {
          id: '91',
          body: data.body,
          user: { id: oauthUser },
          issue_url: 'https://api.github.com/repos/example/demo/issues/8',
        },
        201,
      )
    } else return false
    return true
  })
  const runtimeRoot = join(f.dir, 'runtime')
  const executable = bundledGithubCliPath(runtimeRoot)
  const scenario = join(f.dir, 'behavior')
  const invocation = join(f.dir, 'gh-invocation')
  const system = join(f.dir, 'system-gh')
  mkdirSync(dirname(executable), { recursive: true })
  mkdirSync(system)
  writeFileSync(join(system, 'hosts.yml'), `${oauthToken}\n`, { mode: 0o600 })
  writeFileSync(join(system, 'config.yml'), 'editor: original-editor\n', { mode: 0o600 })
  const systemBefore = new Map(
    readdirSync(system).map((name) => [name, readFileSync(join(system, name))]),
  )
  writeFileSync(scenario, setup.behavior ?? 'success')
  const setBinary = (version: string) =>
    writeFileSync(
      executable,
      `#!${process.execPath}\n` +
        `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const dir = process.env.GH_CONFIG_DIR
const mode = fs.readFileSync(${JSON.stringify(scenario)}, 'utf8')
if (args[0] === '--version') {
  process.stdout.write('gh version ${version} (fixture)\\n')
  process.exit(0)
}
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN ||
    args[0] !== 'auth' || args[args.indexOf('--hostname') + 1] !== 'github.com') process.exit(3)
fs.appendFileSync(${JSON.stringify(invocation)}, JSON.stringify({dir,args}) + '\\n')
if (args[1] === 'token') {
  process.stdout.write(fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8'))
  process.exit(0)
}
if (args[1] !== 'login' || !args.includes('--web') || !args.includes('--insecure-storage') ||
  !args.includes('--clipboard=false') || !args.includes('https') || process.env.GH_PROMPT_DISABLED !== '1')
  process.exit(4)
if (!dir.includes('external-gh-logins') || (fs.statSync(dir).mode & 0o777) !== 0o700) process.exit(5)
if (mode === 'garbled' || mode === 'garbled-hang') {
  process.stderr.write('unexpected output ${oauthToken}\\n')
  if (mode === 'garbled-hang') setInterval(() => {}, 500)
  else process.exit(0)
} else {
  process.stderr.write('! First copy your one-')
  setTimeout(() => {
    process.stderr.write('time code: \\x1b[1mABCD-EFGH\\x1b[0m\\n')
    const host = mode === 'unsafe-url' ? 'github.com.untrusted.invalid' : 'github.com'
    process.stdout.write('Open this URL to continue in your web browser: https://' + host + '/login/device\\n')
    if (mode === 'wait' || mode === 'unsafe-url') setInterval(() => {}, 500)
    else if (mode === 'expire') setTimeout(() => {
      process.stderr.write('device flow error: expired_token\\n')
      process.exitCode = 1
    }, 30)
    else setTimeout(() => {
      fs.writeFileSync(path.join(dir, 'hosts.yml'), '${oauthToken}\\n', { mode: 0o600 })
    }, 30)
  }, 15)
}
`,
      { mode: 0o700 },
    )
  setBinary(BUNDLED_GITHUB_CLI_VERSION)
  const changes: Array<{ loginId: string; revision: number }> = []
  const service = await GithubGhAuthorizationService.create({
    secrets: f.secrets,
    stateDirectory: f.dir,
    runtimeRoot,
    systemGithubConfig: () => system,
    changed: (data) => changes.push(data),
    ...(setup.loginTimeoutMs === undefined ? {} : { loginTimeoutMs: setup.loginTimeoutMs }),
    ...(setup.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: setup.promptTimeoutMs }),
    ...(setup.ownerConfirmationTimeoutMs === undefined
      ? {}
      : { ownerConfirmationTimeoutMs: setup.ownerConfirmationTimeoutMs }),
  })
  t.after(() => service.close())
  return {
    ...f,
    service,
    changes,
    system,
    systemBefore,
    runtimeRoot,
    setBinary,
    changeBehavior: (behavior: Behavior) => writeFileSync(scenario, behavior),
    commands: () =>
      readFileSync(invocation, 'utf8')
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as { args: string[]; dir: string }),
    loginFiles: () => readdirSync(join(f.dir, 'external-gh-logins')),
  }
}

test('固定 gh 搜索不走 PATH，三平台资产路径和精确版本均可校验', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const f = await fixture(t)
  for (const os of ['darwin', 'linux', 'win32'] as const) {
    const file = os === 'win32' ? 'gh.exe' : 'gh'
    for (const arch of ['x64', 'arm64'] as const)
      assert.equal(
        bundledGithubCliPath(f.runtimeRoot, os, arch),
        join(f.runtimeRoot, 'tools', 'github-cli', '2.102.0', `${os}-${arch}`, 'bin', file),
      )
  }
  assert.equal(
    await resolveBundledGithubCli(f.runtimeRoot),
    realpathSync(bundledGithubCliPath(f.runtimeRoot)),
  )
  assert.equal(
    locateSystemGithubConfig({ GH_CONFIG_DIR: f.system, XDG_CONFIG_HOME: f.dir }, 'linux', f.dir),
    f.system,
  )
  assert.equal(
    locateSystemGithubConfig({ APPDATA: f.dir }, 'win32', f.dir),
    join(f.dir, 'GitHub CLI'),
  )
  await assert.rejects(resolveBundledGithubCli(join(f.dir, 'missing')), /bundled_binary_missing/)
  f.setBinary('2.102.1')
  await assert.rejects(resolveBundledGithubCli(f.runtimeRoot), /version_mismatch/)
})

test('设备码登录推送结构化等待态，再核验 scopes/数字身份并保存跨所有者 OAuth 仓库', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const f = await fixture(t)
  const pending = await f.service.add({ operationId: 'login-success', scopes: ['workflow'] })
  assert.equal(pending.state, 'waiting')
  if (pending.state !== 'waiting') return
  assert.equal(pending.userCode, 'ABCD-EFGH')
  assert.equal(pending.verificationUrl, 'https://github.com/login/device')
  assert.equal(
    (await f.service.add({ operationId: 'login-success', scopes: ['workflow'] })).loginId,
    pending.loginId,
  )
  const finished = await f.service.wait(pending.loginId)
  assert.ok(finished.state === 'succeeded')
  assert.equal(finished.needsConfirmation, false)
  assert.equal(finished.result.account.userId, oauthUser)
  assert.deepEqual(finished.result.scopes, [...locked, 'workflow'])
  assert.deepEqual(
    finished.result.repositories.map((repo) => repo.repoId),
    [subject.repoId, otherRepo.id],
  )
  assert.equal(finished.result.identity?.credentials[0]?.credentialKind, 'oauth')
  assert.deepEqual(finished.result.identity?.credentials[0]?.scopes, [...locked, 'workflow'])
  assert.equal(
    f.secrets.activeForRepository(otherRepo.id, oauthUser).metadata.resourceOwnerId,
    oauthUser,
  )
  assert.equal(
    f.secrets.activeForRepository(otherRepo.id, oauthUser).repos[1]?.resourceOwnerId,
    otherRepo.owner.id,
  )
  assert.deepEqual(f.changes, [
    { loginId: pending.loginId, revision: 1 },
    { loginId: pending.loginId, revision: 2 },
  ])
  assert.doesNotMatch(JSON.stringify({ pending, finished, changed: f.changes }), /gho_/)
  assert.deepEqual(f.loginFiles(), [])
  assert.deepEqual(
    f.commands().map(({ args }) => args),
    [
      [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--scopes',
        'repo,read:org,gist,workflow',
        '--insecure-storage',
        '--clipboard=false',
      ],
      ['auth', 'token', '--hostname', 'github.com'],
    ],
  )

  const outbox = new ExternalGithubOutbox({
    store: f.store,
    secrets: f.secrets,
    stateDirectory: f.dir,
    send: f.send,
    now: f.now,
    assignmentForManager: () => ({ identityId: oauthUser, repoIds: [subject.repoId] }),
  })
  const queued = outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'oauth-as-writer',
    intent: {
      action: 'comment',
      body: '用 OAuth 写到属于组织的仓库。',
    },
  })
  await outbox.tick()
  assert.equal(outbox.get(actor, queued.operationId)?.receipt?.botUserId, oauthUser)
})

test('取消等候的设备码会结束 gh；超时和解析失败稳定落入不同状态', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const canceled = await fixture(t, { behavior: 'wait' })
  const started = await canceled.service.add({ operationId: 'start', scopes: [] })
  assert.equal(started.state, 'waiting')
  const cancel = { loginId: started.loginId, operationId: 'cancel' }
  assert.equal((await canceled.service.cancel(cancel)).state, 'canceled')
  assert.equal((await canceled.service.cancel(cancel)).state, 'canceled')
  assert.deepEqual(canceled.loginFiles(), [])
  assert.deepEqual(
    canceled.commands().map(({ args }) => args[1]),
    ['login'],
  )

  const timed = await fixture(t, { behavior: 'wait', loginTimeoutMs: 400 })
  const opened = await timed.service.add({ operationId: 'timeout', scopes: [] })
  assert.equal(opened.state, 'waiting')
  assert.equal((await timed.service.wait(opened.loginId)).state, 'timed_out')
  assert.deepEqual(timed.loginFiles(), [])

  const failed = await fixture(t, {
    behavior: 'garbled-hang',
    promptTimeoutMs: 200,
    loginTimeoutMs: 1500,
  })
  const broken = await failed.service.add({ operationId: 'bad-output', scopes: [] })
  assert.ok(broken.state === 'error')
  assert.equal(broken.code, 'github_gh_device_prompt_unrecognized')
  assert.doesNotMatch(JSON.stringify(broken), /gho_/)
  assert.deepEqual(failed.loginFiles(), [])
  failed.changeBehavior('unsafe-url')
  const wrong = await failed.service.add({ operationId: 'unsafe-site', scopes: [] })
  assert.ok(wrong.state === 'error')
  assert.equal(wrong.code, 'github_gh_device_url_untrusted')
  assert.doesNotMatch(JSON.stringify(wrong), /untrusted\.invalid|ABCD-EFGH/)
})

test('过期设备码可用新的操作 ID 重来；旧任务保持过期', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const f = await fixture(t, { behavior: 'expire' })
  const old = await f.service.add({ operationId: 'old', scopes: [] })
  assert.equal(old.state, 'waiting')
  assert.equal((await f.service.wait(old.loginId)).state, 'expired')
  assert.deepEqual(f.loginFiles(), [])
  f.changeBehavior('success')
  const retry = await f.service.add({ operationId: 'replacement', scopes: [] })
  assert.notEqual(retry.loginId, old.loginId)
  assert.equal((await f.service.wait(retry.loginId)).state, 'succeeded')
  assert.equal(f.service.get(old.loginId).state, 'expired')
})

test('授权到 owner 时暂存；只有正确 revision 的明确确认才落库', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const f = await fixture(t, { userId: owner })
  const start = await f.service.add({ operationId: 'choose-owner', scopes: [] })
  const held = await f.service.wait(start.loginId)
  assert.ok(held.state === 'succeeded')
  assert.equal(held.needsConfirmation, true)
  assert.equal(held.result.isOwner, true)
  assert.equal(held.result.identity, undefined)
  assert.equal(
    f.secrets.identities().some((identity) => identity.identityId === owner),
    false,
  )
  assert.equal(f.secrets.botUserIds().has(owner), false)
  assert.deepEqual(f.loginFiles(), [])
  assert.throws(
    () =>
      f.service.confirm({
        operationId: 'stale',
        loginId: held.loginId,
        expectedRevision: held.revision - 1,
      }),
    /revision_changed/,
  )
  const params = {
    operationId: 'accept-owner',
    loginId: held.loginId,
    expectedRevision: held.revision,
  }
  const confirmed = f.service.confirm(params)
  assert.ok(confirmed.state === 'succeeded')
  assert.equal(confirmed.needsConfirmation, false)
  assert.equal(confirmed.result.identity?.identityId, owner)
  assert.deepEqual(f.service.confirm(params), confirmed)
  assert.equal(f.secrets.activeForRepository(subject.repoId, owner).metadata.botUserId, owner)
  assert.equal(
    (await f.service.cancel({ loginId: held.loginId, operationId: 'past-success' })).state,
    'succeeded',
  )
})

test('owner 取消或确认期到期时不写身份，也不保留私有临时配置', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const f = await fixture(t, { userId: owner, ownerConfirmationTimeoutMs: 250 })
  const first = await f.service.importLogin({ operationId: 'import-owner' })
  assert.ok(first.state === 'succeeded' && first.needsConfirmation)
  assert.equal(
    (await f.service.cancel({ loginId: first.loginId, operationId: 'decline-owner' })).state,
    'canceled',
  )
  const another = await f.service.importLogin({ operationId: 'import-owner-then-expire' })
  assert.ok(another.state === 'succeeded' && another.needsConfirmation)
  await new Promise((resolve) => setTimeout(resolve, 275))
  assert.equal(f.service.get(another.loginId).state, 'expired')
  assert.equal(f.secrets.botUserIds().has(owner), false)
  assert.deepEqual(f.loginFiles(), [])
})

test('导入只调用 gh auth token；必要 scope 或请求的可选 scope 缺少时拒绝保存', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const imported = await fixture(t, { scopes: 'repo, write:org, gist' })
  const result = await imported.service.importLogin({
    operationId: 'imported',
    accountLogin: 'device-oauth',
  })
  assert.ok(result.state === 'succeeded')
  assert.deepEqual(result.result.scopes, ['gist', 'repo', 'write:org'])
  assert.deepEqual(imported.commands(), [
    {
      dir: realpathSync(imported.system),
      args: ['auth', 'token', '--hostname', 'github.com', '--user', 'device-oauth'],
    },
  ])
  assert.deepEqual(
    new Map(
      readdirSync(imported.system).map((name) => [name, readFileSync(join(imported.system, name))]),
    ),
    imported.systemBefore,
  )

  const noRequired = await fixture(t, { scopes: 'repo,gist' })
  const missing = await noRequired.service.importLogin({ operationId: 'missing-org' })
  assert.ok(missing.state === 'error')
  assert.equal(missing.code, 'github_oauth_scopes_insufficient')
  assert.equal(noRequired.secrets.botUserIds().has(oauthUser), false)

  const noOptional = await fixture(t, { scopes: 'repo,read:org,gist' })
  const initial = await noOptional.service.add({
    operationId: 'missing-workflow',
    scopes: ['workflow'],
  })
  const failed = await noOptional.service.wait(initial.loginId)
  assert.ok(failed.state === 'error')
  assert.equal(failed.code, 'github_oauth_scopes_insufficient')
  assert.equal(noOptional.secrets.botUserIds().has(oauthUser), false)
  assert.throws(
    () => noOptional.service.add({ operationId: 'bad-scope', scopes: ['delete_repo'] }),
    /scope_invalid/,
  )
})

test('受管 gh 不可用时，仍能通过高级入口存入细粒度 PAT', async (t) => {
  if (process.platform === 'win32') return t.skip('假 gh 使用 Unix 可执行脚本')
  const f = await fixture(t)
  f.setBinary('2.102.1')
  const badBinary = await f.service.add({ operationId: 'wrong-binary', scopes: [] })
  assert.ok(badBinary.state === 'error')
  assert.equal(badBinary.code, 'github_gh_version_mismatch')
  const advanced = await f.service.paste({ operationId: 'advanced', token: token('advanced') })
  assert.ok(advanced.state === 'succeeded')
  assert.equal(advanced.result.identity?.credentials[0]?.credentialKind, 'fine_grained')
  assert.deepEqual(advanced.result.scopes, [])
  assert.doesNotMatch(JSON.stringify(advanced), /github_pat_/)
})
