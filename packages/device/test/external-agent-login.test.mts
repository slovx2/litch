import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkIdentityRepositoryWrites } from '../src/external/execution-boundary.mjs'
import { GithubWriteFault } from '../src/external/github/write-api.mjs'

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
interface Ran {
  code: number
  out: string
  err: string
}
function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  data?: string,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(executable, args, { env, cwd, timeout: 8000 }, (error, out, err) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, out, err }),
    )
    child.stdin?.end(data)
  })
}
async function call(...input: Parameters<typeof run>): Promise<string> {
  const result = await run(...input)
  if (result.code !== 0) throw new Error(`夹具命令失败: ${result.code}`)
  return result.out
}
// 假 gh：带 GH_TOKEN 时报告宿主配置，否则打印设备写的 hosts.yml。
const fakeGh = (path: string) =>
  writeFileSync(
    path,
    `#!${process.execPath}\n
const fs = require('node:fs')
const cfg = process.env.GH_CONFIG_DIR
if (process.env.GH_TOKEN) process.stdout.write('host:' + cfg)
else process.stdout.write(fs.readFileSync(require('node:path').join(cfg, 'hosts.yml'), 'utf8'))
`,
    { mode: 0o700 },
  )
// 不在 git 仓库里、也不带 -R 的典型命令：附件、发布资产、API。
const unscopedCommands = [
  ['pr', 'edit', '829', '--body-file', 'body.md', '--attach', 'shot.png'],
  ['release', 'upload', 'evidence', 'shot.png'],
  ['api', '/user'],
  ['pr', 'comment', '829', '--repo', 'other/unassigned', '--body', 'x'],
]
const gitFill = (
  env: NodeJS.ProcessEnv,
  cwd: string,
  path = 'example/demo.git',
  host = 'github.com',
) => run(git, ['credential', 'fill'], env, cwd, `protocol=https\nhost=${host}\npath=${path}\n\n`)

test('注入后 gh/Git 在任何目录都用经理身份；凭据轮换跟新代，失效、撤销时报错不回退宿主', async (t) => {
  if (process.platform === 'win32') return t.skip('Git/gh Unix 夹具')
  const f = await externalFixture(t)
  const fixtureGh = join(f.dir, 'fixture-system-gh')
  const fixtureHost = join(f.dir, 'system-gh-config')
  fakeGh(fixtureGh)
  const outside = join(f.dir, 'outside')
  mkdirSync(outside)
  const env = {
    PATH: '/usr/bin:/bin',
    GH_TOKEN: 'host-fixture',
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
  let prepares = 0
  let downloadFails = true
  const service = await GithubAgentLoginService.start({
    store: f.store,
    secrets: f.secrets,
    callbackPath: join(f.dir, 'gh.sock'),
    ghPath: fixtureGh,
    prepareGh: async () => {
      prepares++
      if (downloadFails) throw new GithubWriteFault('github_gh_download_unavailable')
      return fixtureGh
    },
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
  // 普通会话、不属于经理的工作线不注入，环境原样。
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
  // 句柄编在助手路径里：用哪个会话的环境，就跑哪个会话的 gh。
  const gh = (args: string[], launch: { env: NodeJS.ProcessEnv; ghPath?: string } = manager) =>
    run(launch.ghPath ?? '', args, launch.env, outside)

  // Git：github.com 不论仓库都用注入凭据，其他主机仍用宿主配置。
  assert.match((await gitFill(manager.env, outside)).out, new RegExp(token()))
  assert.match(
    (await gitFill(manager.env, outside, 'other/unassigned.git')).out,
    new RegExp(token()),
  )
  assert.match(
    (await gitFill(manager.env, outside, 'x/y.git', 'different.invalid')).out,
    /host-fixture/,
  )
  assert.match((await gitFill(line.env, outside)).out, new RegExp(token()))
  assert.equal(prepares, 0, 'Git 不需要下载受管 gh')
  const failed = await gh(['api', '/user'])
  assert.equal(failed.code, 1, '下载失败也不执行宿主 gh')
  assert.match(failed.err, /github_gh_download_unavailable/)
  assert.equal(existsSync(hosts), false)
  downloadFails = false

  // 不在仓库目录、不带 -R、甚至指向未分派仓库，都用经理身份。
  for (const args of unscopedCommands) {
    assert.match((await gh(args)).out, new RegExp(token()), args.join(' '))
    assert.match((await gh(args, line)).out, new RegExp(token()), args.join(' '))
  }
  assert.match(
    (await gh(['api', '/user'], { ghPath, env: { ...manager.env, GH_REPO: 'other/x' } })).out,
    new RegExp(token()),
  )
  assert.equal(statSync(hosts).mode & 0o777, 0o600)

  const rotate = await f.secrets.rotate({
    operationId: 'agent-rotate',
    expectedGeneration: 1,
    credentialRef: f.credentialRef,
    token: token('rotated'),
  })
  assert.equal(rotate.record?.generation, 2)
  assert.match(readFileSync(hosts, 'utf8'), new RegExp(token('rotated')))
  assert.match((await gitFill(manager.env, outside)).out, new RegExp(token('rotated')))
  assert.match(
    (await gh(['release', 'upload', 'evidence', 'a.png'])).out,
    new RegExp(token('rotated')),
  )

  // 来源暂停只停采集，不影响经理身份的注入。
  assert.equal(
    f.store.config.saveSource({ ...f.source, enabled: false }, 1, 'config-1', 'user').outcome,
    'applied',
  )
  service.refresh()
  assert.equal(service.environment(actor, env).resolution.state, 'active')
  assert.match((await gh(['api', '/user'])).out, new RegExp(token('rotated')))

  // 注入关闭：新命令拿到原环境（宿主 gh）；已发出的句柄报错，不改用宿主凭据。
  turnedOff = true
  service.refresh()
  assert.equal(service.environment(actor, env).env, env)
  assert.equal(existsSync(hosts), false)
  const off = await gh(['api', '/user'])
  assert.equal(off.code, 1)
  assert.match(off.err, /github_agent_injection_off/)
  const offGit = await gitFill(manager.env, outside)
  assert.doesNotMatch(offGit.out, /host-fixture|github_pat_/)
  turnedOff = false
  service.refresh()
  assert.match((await gh(['api', '/user'])).out, new RegExp(token('rotated')))
  lineIsCurrent = false
  assert.doesNotMatch((await gitFill(line.env, outside)).out, /host-fixture|github_pat_/)
  const gone = await gh(['api', '/user'], line)
  assert.match(gone.err, /github_agent_not_authorized/, JSON.stringify(gone))

  // 凭据失效、撤销：仍是注入的会话，命令说明原因并失败，绝不回退宿主 gh/Git。
  const active = f.secrets.active(f.credentialRef)
  f.store.invalidateExternalCredential(
    f.credentialRef,
    active.metadata.generation,
    f.now(),
    'github_credential_invalid',
  )
  for (const args of unscopedCommands) {
    const broken = await gh(args)
    assert.equal(broken.code, 1, args.join(' '))
    assert.equal(broken.out, '')
    assert.match(broken.err, /github_agent_credential_unavailable: .*Re-authorize/)
    assert.match(broken.err, /System gh credentials are not used/)
  }
  const brokenGit = await gitFill(manager.env, outside)
  assert.doesNotMatch(brokenGit.out, /host-fixture|github_pat_/)
  assert.match(brokenGit.err, /git: github_agent_credential_unavailable/)
  const fresh = service.environment(actor, env)
  assert.equal(fresh.resolution.state, 'broken')
  assert.ok(fresh.ghPath, '失效时新命令也走设备助手')
  assert.match((await gh(['api', '/user'], fresh)).err, /github_agent_credential_unavailable/)
  fresh.dispose()
  assert.equal(
    f.secrets.revoke({
      operationId: 'agent-revoke',
      expectedGeneration: 2,
      credentialRef: f.credentialRef,
    }).record?.state,
    'revoked',
  )
  assert.equal(existsSync(hosts), false)
  assert.equal(service.environment(actor, env).resolution.state, 'broken')
  assert.doesNotMatch((await gitFill(manager.env, outside)).out, /github_pat_|host-fixture/)
  assert.equal((await gh(['api', '/user'])).code, 1)
  line.dispose()
  manager.dispose()
})

test('经理身份有两份可用凭据视为配置异常：gh/Git 报错说明怎么办，不替 Agent 挑一份', async (t) => {
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
  assert.equal(identity.credentials.length, 2)
  const page = f.secrets.repositories({ limit: 1, identityId: bot })
  assert.equal(page.repositories[0]?.repoId, subject.repoId)
  assert.ok(page.nextCursor)
  const next = f.secrets.repositories({ cursor: page.nextCursor, limit: 1, identityId: bot })
  assert.equal(next.repositories[0]?.grants[0]?.write, 'missing')
  assert.doesNotMatch(JSON.stringify({ identity, page, next }), /github_pat_/)
  const credential = identity.credentials.find((entry) => entry.resourceOwnerId === secondOwner)
  const repo = f.source.repos[0]
  assert.ok(credential && repo)
  const write = checkIdentityRepositoryWrites({
    secrets: f.secrets,
    identityId: bot,
    repositories: [{ ...repo, repoId: secondId, owner: 'other', name: 'second' }],
  })
  assert.equal(write[0]?.code, 'github_robot_needs_repository_write_access')

  const fixtureGh = join(f.dir, 'fake-gh')
  fakeGh(fixtureGh)
  const hostGit = join(f.dir, 'host-git')
  writeFileSync(
    hostGit,
    `[credential]\n\thelper = "!f() { echo username=host; echo password=host-fixture; }; f"\n`,
  )
  const service = await GithubAgentLoginService.start({
    store: f.store,
    secrets: f.secrets,
    callbackPath: join(f.dir, 'gh.sock'),
    ghPath: fixtureGh,
    stateDirectory: f.dir,
    isWorklineCurrent: () => false,
    assignmentForManager: () => ({ identityId: bot, repoIds: [subject.repoId, secondId] }),
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
  assert.equal(launch.resolution.state, 'broken')
  const shim = launch.ghPath
  assert.ok(shim)
  for (const args of [...unscopedCommands, ['pr', 'list', '--repo', 'example/demo']]) {
    const failed = await run(shim, args, launch.env, f.dir)
    assert.equal(failed.code, 1, args.join(' '))
    assert.equal(failed.out, '')
    assert.match(failed.err, /github_agent_identity_ambiguous: .*Keep only one/)
  }
  for (const path of ['example/demo.git', 'other/second.git']) {
    const filled = await gitFill(launch.env, f.dir, path)
    assert.doesNotMatch(filled.out, /github_pat_|host-fixture/)
    assert.match(filled.err, /github_agent_identity_ambiguous/)
  }

  // 去掉一份后恢复：剩下的那份在任何目录、对任何仓库都用。
  f.secrets.revokeIdentityCredential({
    identityId: bot,
    credentialRef: credential.credentialRef,
    operationId: 'remove-other',
    expectedGeneration: 1,
  })
  for (const args of unscopedCommands)
    assert.match(await call(shim, args, launch.env, f.dir), new RegExp(token()))
  assert.match((await gitFill(launch.env, f.dir, 'other/second.git')).out, new RegExp(token()))
  // SSH 地址改写成 HTTPS，也走注入凭据。
  const cwd = join(f.dir, 'repo')
  mkdirSync(cwd)
  await call(git, ['init', '--quiet'], launch.env, cwd)
  await call(git, ['remote', 'add', 'origin', 'git@github.com:example/demo.git'], launch.env, cwd)
  assert.equal(
    (await call(git, ['remote', 'get-url', 'origin'], launch.env, cwd)).trim(),
    'https://github.com/example/demo.git',
  )
  f.secrets.revokeIdentityCredential({
    identityId: bot,
    credentialRef: f.credentialRef,
    expectedGeneration: 1,
    operationId: 'remove-bot',
  })
  assert.equal(service.environment(actor, { PATH: '/usr/bin:/bin' }).resolution.state, 'broken')
  assert.equal((await run(shim, ['api', '/user'], launch.env, cwd)).code, 1)
  assert.deepEqual([...f.secrets.botUserIds()], [bot])
})
