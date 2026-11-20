import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkIdentityRepositoryWrites } from '../src/external/execution-boundary.mjs'

import { GithubAgentLoginService } from '../src/external/secrets-agent-login.mjs'
import {
  actor,
  bot,
  externalFixture,
  repoMetadata,
  resource,
  respond,
  subject,
  token,
} from './fixtures/external-d.mjs'

const git = '/usr/bin/git'
function call(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  data?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { env, cwd, timeout: 8000 }, (error, stdout) => {
      if (error) reject(new Error(`夹具命令失败: ${error.code}`))
      else resolve(stdout)
    })
    child.stdin?.end(data)
  })
}

test('经理身份注入默认开启，运行中的 gh/Git 寻址随轮换、暂停、失效、撤销更新', async (t) => {
  if (process.platform === 'win32') return t.skip('Git/gh Unix 夹具')
  const f = await externalFixture(t)
  const fixtureGh = join(f.dir, 'fixture-system-gh')
  const fixtureHost = join(f.dir, 'system-gh-config')
  writeFileSync(
    fixtureGh,
    `#!${process.execPath}\n
const fs = require('node:fs')
const cfg = process.env.GH_CONFIG_DIR
if (process.env.GH_TOKEN) process.stdout.write('host:' + cfg)
else process.stdout.write(fs.readFileSync(require('node:path').join(cfg, 'hosts.yml'), 'utf8'))
`,
    { mode: 0o700 },
  )
  const env = {
    PATH: '/usr/bin:/bin',
    GH_TOKEN: 'host-fixture',
    GH_REPO: 'example/demo',
    GH_CONFIG_DIR: fixtureHost,
    HOME: f.dir,
    GIT_CONFIG_GLOBAL: join(f.dir, 'host-git-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  writeFileSync(
    env.GIT_CONFIG_GLOBAL,
    `[credential]\n\thelper = "!f() { echo username=host; echo password=host-fixture; }; f"\n`,
  )
  let turnedOff = false
  let lineIsCurrent = true
  const service = await GithubAgentLoginService.start({
    store: f.store,
    secrets: f.secrets,
    callbackPath: join(f.dir, 'gh.sock'),
    ghPath: fixtureGh,
    gitPath: git,
    stateDirectory: f.dir,
    assignmentForManager: () => ({
      identityId: bot,
      repoIds: [subject.repoId],
      injectCredentials: !turnedOff,
    }),
    isWorklineCurrent: (line) =>
      lineIsCurrent && line.threadId === 'line' && line.issueId === f.request.issueId,
  })
  t.after(() => service.close())
  assert.equal(service.environment({ ...actor, threadId: 'ordinary' }, env).env, env)
  assert.equal(service.environment({ ...actor, kind: 'workline', issueId: 'X-3' }, env).env, env)
  const manager = service.environment(actor, env)
  const line = service.environment(
    { ...actor, kind: 'workline', threadId: 'line', issueId: f.request.issueId },
    env,
  )
  assert.equal(manager.resolution.state, 'active')
  assert.equal(line.resolution.state, 'active')
  assert.ok(manager.ghPath && line.ghPath)
  const ghPath = manager.ghPath
  const hosts = join(dirname(ghPath), `owner-${resource}`, 'hosts.yml')
  assert.doesNotMatch(JSON.stringify(manager.env), /github_pat_/)
  assert.equal(manager.env.GH_TOKEN, env.GH_TOKEN)
  const credential = (host = 'github.com', processEnv = manager.env) =>
    call(
      git,
      ['credential', 'fill'],
      processEnv,
      f.dir,
      `protocol=https\nhost=${host}\npath=example/demo.git\n\n`,
    )
  const gh = () => call(ghPath, ['api', '/user'], manager.env, f.dir)
  assert.match(await gh(), new RegExp(token()))
  assert.equal(statSync(hosts).mode & 0o777, 0o600)
  assert.match(await credential(), new RegExp(token()))
  assert.match(await credential('different.invalid'), /password=host-fixture/)
  assert.match(await credential('github.com', line.env), new RegExp(token()))

  const rotate = await f.secrets.rotate({
    operationId: 'agent-rotate',
    expectedGeneration: 1,
    credentialRef: f.credentialRef,
    token: token('rotated'),
  })
  assert.equal(rotate.record?.generation, 2)
  assert.match(readFileSync(hosts, 'utf8'), new RegExp(token('rotated')))
  assert.match(await credential(), new RegExp(token('rotated')))
  assert.match(await gh(), new RegExp(token('rotated')))

  const changed = (enabled: boolean, rev: number) => {
    assert.equal(
      f.store.config.saveSource({ ...f.source, enabled }, rev, `config-${rev}`, 'user').outcome,
      'applied',
    )
    service.refresh()
  }
  changed(false, 1)
  assert.equal(service.environment(actor, env).env, env)
  assert.equal(existsSync(hosts), false)
  assert.match(await credential(), /password=host-fixture/)
  assert.equal(await gh(), `host:${fixtureHost}`)
  changed(true, 2)
  turnedOff = true
  service.refresh()
  assert.equal(service.environment(actor, env).env, env)
  assert.equal(existsSync(hosts), false)
  assert.match(await credential(), /password=host-fixture/)
  turnedOff = false
  service.refresh()
  assert.match(await credential(), new RegExp(token('rotated')))
  assert.match(await gh(), new RegExp(token('rotated')))
  lineIsCurrent = false
  assert.match(await credential('github.com', line.env), /password=host-fixture/)

  const active = f.secrets.active(f.credentialRef)
  f.store.invalidateExternalCredential(
    f.credentialRef,
    active.metadata.generation,
    f.now(),
    'github_credential_invalid',
  )
  assert.match(await credential(), /password=host-fixture/)
  assert.equal(await gh(), `host:${fixtureHost}`)
  assert.equal(
    f.secrets.revoke({
      operationId: 'agent-revoke',
      expectedGeneration: 2,
      credentialRef: f.credentialRef,
    }).record?.state,
    'revoked',
  )
  assert.equal(existsSync(hosts), false)
  assert.equal(service.environment(actor, env).env, env)
  assert.doesNotMatch(await credential(), /github_pat_/)
  assert.equal(await gh(), `host:${fixtureHost}`)
  line.dispose()
  manager.dispose()
})

test('经理身份持有两个资源所有者的 PAT，gh/Git 按准确仓库选令牌，不扩大经理分配', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix 回调夹具')
  const secondId = '90071992547410000'
  const secondOwner = '90071992547410001'
  const secondPath = '/repos/other/second'
  const second = {
    ...repoMetadata,
    id: secondId,
    name: 'second',
    full_name: 'other/second',
    owner: { ...repoMetadata.owner, id: secondOwner, login: 'other' },
    permissions: { push: false },
  }
  const f = await externalFixture(t, (req, res, url) => {
    if (req.headers.authorization !== `Bearer ${token('second')}`) return false
    if (url.pathname === '/user/repos') respond(res, [second])
    else if (url.pathname === secondPath) respond(res, second)
    else if (url.pathname === `${secondPath}/actions/runs`) respond(res, { workflow_runs: [] })
    else if (url.pathname.startsWith(`${secondPath}/`)) respond(res, [])
    else return false
    return true
  })
  const { identity } = await f.secrets.addIdentity({
    operationId: 'second',
    token: token('second'),
  })
  assert.equal(identity.identityId, bot)
  assert.equal(identity.revision, 2)
  assert.equal(identity.credentials.length, 2)
  assert.deepEqual([...f.secrets.botUserIds()], [bot])
  const page = f.secrets.repositories({ limit: 1, identityId: bot })
  assert.equal(page.repositories[0]?.repoId, subject.repoId)
  assert.ok(page.nextCursor)
  const next = f.secrets.repositories({ cursor: page.nextCursor, limit: 1, identityId: bot })
  assert.equal(next.repositories[0]?.grants[0]?.write, 'missing')
  assert.equal(next.nextCursor, null)
  assert.doesNotMatch(JSON.stringify({ identity, page, next }), /github_pat_/)

  const repo = f.source.repos[0]
  const credential = identity.credentials.find((entry) => entry.resourceOwnerId === secondOwner)
  assert.ok(repo && credential)
  const { store } = f
  const draft = {
    ...f.source,
    sourceId: 'second',
    credentialRef: credential.credentialRef,
    repos: [
      {
        ...repo,
        repoId: secondId,
        owner: 'other',
        name: 'second',
        url: 'https://github.com/other/second',
      },
    ],
    routes: [],
  }
  assert.equal(store.config.saveSource(draft, 0, 'source-second', 'user').outcome, 'applied')
  const fixtureGh = join(f.dir, 'fake-gh')
  writeFileSync(
    fixtureGh,
    `#!${process.execPath}\n
const fs = require('node:fs')
const cfg = process.env.GH_CONFIG_DIR
if (process.env.GH_TOKEN) process.stdout.write('host')
else process.stdout.write(fs.readFileSync(require('node:path').join(cfg, 'hosts.yml'), 'utf8'))
`,
    { mode: 0o700 },
  )
  const hostGit = join(f.dir, 'host-git')
  writeFileSync(
    hostGit,
    `[credential]\n\thelper = "!f() { echo username=host; echo password=host-fixture; }; f"\n`,
  )
  let repoIds = [subject.repoId, secondId]
  const service = await GithubAgentLoginService.start({
    store,
    secrets: f.secrets,
    callbackPath: join(f.dir, 'gh.sock'),
    ghPath: fixtureGh,
    gitPath: git,
    stateDirectory: f.dir,
    isWorklineCurrent: () => false,
    assignmentForManager: () => ({ identityId: bot, repoIds }),
  })
  t.after(() => service.close())
  const launch = service.environment(actor, {
    GH_TOKEN: 'mock-host',
    HOME: f.dir,
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: hostGit,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  })
  const shim = launch.ghPath
  assert.ok(shim)
  const gh = (repository: string) =>
    call(shim, ['pr', 'list', '--repo', repository], launch.env, f.dir)
  const credentialFor = (repository: string) =>
    call(
      git,
      ['credential', 'fill'],
      launch.env,
      f.dir,
      `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
    )
  assert.match(await gh('example/demo'), new RegExp(token()))
  assert.match(await gh('other/second'), new RegExp(token('second')))
  assert.match(await credentialFor('example/demo'), new RegExp(token()))
  assert.match(await credentialFor('other/second'), new RegExp(token('second')))
  assert.match(await credentialFor('other/unassigned'), /password=host-fixture/)
  assert.equal(await gh('example.invalid/other/second'), 'host')

  const write = checkIdentityRepositoryWrites({
    secrets: f.secrets,
    identityId: bot,
    repositories: draft.repos,
  })
  assert.equal(write[0]?.code, 'github_robot_needs_repository_write_access')
  assert.equal(write[0]?.state, 'unverified')
  repoIds = [subject.repoId]
  service.refresh()
  assert.equal(await gh('other/second'), 'host')
  assert.match(await credentialFor('other/second'), /password=host-fixture/)

  repoIds = [subject.repoId, secondId]
  f.secrets.revokeIdentityCredential({
    identityId: bot,
    credentialRef: credential.credentialRef,
    operationId: 'remove-other',
    expectedGeneration: 1,
  })
  assert.equal(await gh('other/second'), 'host')
  assert.match(await gh('example/demo'), new RegExp(token()))
  const cwd = f.dir
  await call(git, ['init', '--quiet'], launch.env, cwd)
  await call(git, ['remote', 'add', 'origin', 'git@github.com:example/demo.git'], launch.env, cwd)
  assert.match(await call(shim, ['pr', 'list'], launch.env, cwd), new RegExp(token()))
  f.secrets.revokeIdentityCredential({
    identityId: bot,
    credentialRef: f.credentialRef,
    expectedGeneration: 1,
    operationId: 'remove-bot',
  })
  assert.equal(await gh('example/demo'), 'host')
  assert.deepEqual([...f.secrets.botUserIds()], [bot])
})
