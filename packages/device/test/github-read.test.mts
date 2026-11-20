import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  githubIdentity,
  lookupGithubRole,
  mentionsGithubLogin,
  verifyGithubBot,
} from '../src/external/github/identity.mjs'
import { pollGithubRepository } from '../src/external/github/poll.mjs'
import { readGithubBody } from '../src/external/github/read.mjs'
import { GithubFault } from '../src/external/github/read-api.mjs'
import {
  base,
  githubFixture,
  iso,
  MemoryGithubStore,
  repo,
  sourceId,
  start,
} from './github-poll-fixture.mjs'

test('数字身份、同名改绑、triage 与自定义角色基础权限', async (t) => {
  const roles = {
    triage: { permission: 'read', role_name: 'triage', user: { id: '9007199254740995' } },
    read: { permission: 'read', role_name: 'read', user: { id: '2' } },
    custom: { permission: 'read', role_name: 'helper', user: { id: '3' } },
    writer: { permission: 'write', role_name: 'custom-writer', user: { id: '4' } },
    wrong: { permission: 'admin', role_name: 'admin', user: { id: '5' } },
    missing: null,
  }
  const fx = await githubFixture(t, (url) => {
    if (!url.pathname.includes('/permission')) return
    const login = url.pathname.split('/').at(-2) as keyof typeof roles
    return roles[login]
      ? { raw: JSON.stringify(roles[login]).replace(/"(9007199254740995)"/, '$1') }
      : { status: 404 }
  })
  assert.deepEqual(await verifyGithubBot(fx.api, '99'), { userId: '99', login: 'litch-bot' })
  assert.equal(githubIdentity({ userId: '99', login: 'new-name' }, '99', '5'), 'robot')
  assert.equal(githubIdentity({ userId: '5', login: 'new-owner-name' }, '99', '5'), 'owner')
  assert.equal(githubIdentity({ userId: '6', login: 'litch-bot' }, '99', '5'), 'other')
  async function role(login: string, userId: string, configured?: readonly string[]) {
    const result = await lookupGithubRole(fx.api, repo, { login, userId }, configured)
    return result.state === 'verified' ? result.eligible : result.state
  }
  assert.equal(await role('triage', '9007199254740995'), true)
  assert.equal(await role('read', '2'), false)
  assert.equal(await role('custom', '3'), false)
  assert.equal(await role('custom', '3', ['helper']), true)
  assert.equal(await role('writer', '4'), true)
  assert.equal(await role('wrong', '6'), 'identity-mismatch')
  assert.equal(await role('missing', '7'), 'unavailable')
})

test('提及按完整登录名识别，代码、引用和链接目标不算提及', () => {
  const bot = 'litch-bot'
  for (const no of [
    'mail@litch-bot.example',
    '@litch-bot-suffix',
    '@litch-bot/team',
    '\\@litch-bot',
    'x@litch-bot',
    '请在 `/send @litch-bot` 中输入',
    '`` 片段 ` @litch-bot ``',
    '  ```md\n@litch-bot\n  ```',
    '- ~~~~\n @litch-bot\n  ~~~~',
    '    @litch-bot',
    '> 不要按这个执行\n@litch-bot',
    'https://github.com/org/repo?q=@litch-bot',
    '<https://domain.test/@litch-bot>',
    '[link](foo/@litch-bot "title")',
    '[ignored]: https://a.test/@litch-bot',
    '<!--\n@litch-bot\n-->',
    '<blockquote>\n@litch-bot\n</blockquote>',
  ])
    assert.equal(mentionsGithubLogin(no, bot), false, no)
  for (const yes of [
    '请求：(@LITCH-BOT)，请处理',
    '请 @litch-bot.',
    '> 引用\n\n@litch-bot',
    '[@litch-bot](https://a.test)',
  ]) {
    assert.equal(mentionsGithubLogin(yes, bot), true, yes)
  }
})

test('主限额计入服务端重置时钟，二级限流跨成功读请求仍指数退避', async (t) => {
  let status = 'primary'
  const fx = await githubFixture(t, (url, _req, now) => {
    if (url.pathname !== '/rate') return
    if (status === 'primary')
      return {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(now / 1000 + 20),
          'Retry-After': '31',
        },
      }
    return {
      status: 403,
      headers: { 'X-RateLimit-Remaining': '100', 'Retry-After': '90' },
      body: { message: 'secondary rate limit' },
    }
  })
  const errorAt = (kind: GithubFault['kind'], time: number) => (error: unknown) =>
    error instanceof GithubFault && error.kind === kind && error.retryAt === time
  await assert.rejects(fx.api.get('/rate'), errorAt('primary-rate', fx.now() + 31_000))
  await assert.rejects(fx.api.get('/user'), errorAt('primary-rate', fx.now() + 31_000))
  assert.equal(fx.requests.length, 1)
  fx.advance(31_000)
  status = 'secondary'
  await assert.rejects(fx.api.get('/rate'), errorAt('secondary-rate', fx.now() + 90_000))
  fx.advance(90_000)
  await fx.api.get('/user')
  await assert.rejects(fx.api.get('/rate'), errorAt('secondary-rate', fx.now() + 120_000))
  assert.equal(fx.requests.length, 4)
})

test('认证失效暂停整个来源，仓库和端点 404 各自暂停；无水位变化或匿名读取', async (t) => {
  let mode = 'auth'
  const fx = await githubFixture(t, (url) => {
    if (mode === 'auth' && url.pathname === '/user')
      return { status: 401, body: { message: 'DO_NOT_PRINT' } }
    if (mode === 'repo' && url.pathname === base) return { status: 404 }
    if (mode === 'endpoint' && url.pathname === `${base}/issues/events`) return { status: 404 }
    if (mode === 'disabled' && url.pathname === `${base}/issues/comments`) return { status: 410 }
    return undefined
  })
  const store = new MemoryGithubStore()
  const options = { sourceId, repo, api: fx.api, store, botUserId: '99', enabledAt: start }
  const auth = await pollGithubRepository(options)
  assert.deepEqual(auth.fault, {
    kind: 'authentication',
    scope: 'credential',
    paused: true,
    reason: 'credential-rejected',
  })
  assert.equal(store.cursors.size, 0)
  mode = 'repo'
  assert.deepEqual((await pollGithubRepository({ ...options, api: fx.client() })).fault, auth.fault)
  assert.equal(fx.requests.length, 1)
  const rotated = { ...options, api: fx.client('fixture-2') }
  const missing = await pollGithubRepository(rotated)
  assert.equal(missing.fault?.reason, 'repository-unavailable')
  assert.equal(missing.fault?.scope, 'repository')
  assert.equal(store.cursors.size, 0)
  mode = 'endpoint'
  const endpoints = await pollGithubRepository({ ...rotated, resume: true })
  assert.equal(endpoints.fault, undefined)
  const events = endpoints.streams.find((row) => row.key.stream === 'issue-events')?.cursor
  assert.equal(events?.fault?.reason, 'endpoint-unavailable')
  assert.equal(events?.coveredThrough, start)
  assert.equal(
    endpoints.streams.find((row) => row.key.stream === 'issues')?.cursor.coveredThrough,
    fx.now() - 5000,
  )
  mode = 'disabled'
  fx.advance(120_000)
  const disabled = await pollGithubRepository(rotated)
  const comments = disabled.streams.find((row) => row.key.stream === 'issue-comments')?.cursor
  assert.equal(comments?.fault?.reason, 'feature-disabled')
  assert.equal(comments?.coveredThrough, start + 55_000)
})

test('正文读取只给 gh 固定主机、GET 数组和专用凭据，旧登录与 stderr 不透传', {
  skip: process.platform === 'win32',
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'litch-test-gh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binary = join(dir, 'fake-gh')
  await writeFile(
    binary,
    `#!${process.execPath}
const assert = require('node:assert/strict')
const fs = require('node:fs')
const args = process.argv.slice(2)
assert.deepEqual(args.slice(0, 6), ['api', '--hostname', 'github.com', '--method', 'GET', '--header'])
assert.equal(args.at(-2), '--')
assert.equal(process.cwd(), fs.realpathSync(process.env.GH_CONFIG_DIR))
assert.equal(process.env.HOME, process.env.GH_CONFIG_DIR)
assert.deepEqual(fs.readdirSync(process.env.GH_CONFIG_DIR), [])
assert.equal(process.env.GH_TOKEN, 'injected-token')
for (const key of ['GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','HTTPS_PROXY','SSH_AUTH_SOCK','LITCH_TEST_ISOLATED']) assert.equal(process.env[key], undefined)
if (args.at(-1) === '${base}') console.log('{"id":${repo.repoId},"full_name":"org/sample"}')
else if (args.at(-1) === '${base}/issues/1') console.log(JSON.stringify({
  id: 123, number: 1, user: { id: 42, login: 'source-user' }, body: '正文',
  created_at: '${iso(start)}', updated_at: '${iso(start)}',
}))
else { console.error('DO_NOT_PRINT injected-token'); process.exit(1) }
`,
    { mode: 0o700 },
  )
  const options = { ghPath: binary, token: 'injected-token' }
  const content = await readGithubBody(options, repo, { kind: 'issue', number: 1, objectId: '123' })
  assert.equal(content.body, '正文')
  assert.equal(content.permalink, 'https://github.com/org/sample/issues/1')
  assert.equal(content.actorEvidence.userId, '42')
  assert.match(content.contentVersion, /\/[a-f\d]{64}$/)
  await assert.rejects(
    readGithubBody(options, repo, { kind: 'issue', number: 2 }),
    /^Error: GitHub: transient$/,
  )
  await assert.rejects(
    readGithubBody(options, repo, { kind: 'review-comment', number: 1, objectId: '123?host=evil' }),
    TypeError,
  )
})
