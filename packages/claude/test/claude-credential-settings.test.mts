import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ignoresProjectSignIn } from '../src/claude-credential-settings.mjs'
import { ACCOUNT_PROVIDER, providerLaunch } from '../src/claude-provider.mjs'
import { hostClaudeRelease } from '../src/host-claude.mjs'
import { rateLimitCredentialScope } from '../src/rate-limits.mjs'
import { isolatedEnv } from './fixtures/isolated-env.mjs'

function fixture(version: string) {
  const home = mkdtempSync(join(tmpdir(), 'credential-settings-'))
  const config = join(home, 'user')
  const project = join(home, 'work')
  mkdirSync(config)
  mkdirSync(join(project, '.claude'), { recursive: true })
  const cli = join(home, 'claude.mjs')
  writeFileSync(cli, `process.stdout.write('${version} (Claude Code)\\n')`, { mode: 0o700 })
  const env = {
    ...isolatedEnv,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    CHA_CLAUDE_CLI: cli,
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-launch-token',
  }
  const write = (file: string, values: Record<string, unknown>) =>
    writeFileSync(file, JSON.stringify({ env: values }))
  const userFile = join(config, 'settings.json')
  const projectFile = join(project, '.claude', 'settings.json')
  const localFile = join(project, '.claude', 'settings.local.json')
  const launch = { env, flagSettings: null }
  return {
    home,
    project,
    cli,
    env,
    launch,
    userFile,
    projectFile,
    localFile,
    write,
    close: () => rmSync(home, { recursive: true, force: true }),
  }
}

test('项目账号凭据的已验证门槛是 2.1.312，不是通知文案出现的版本', () => {
  assert.equal(ignoresProjectSignIn('2.1.282'), false)
  assert.equal(ignoresProjectSignIn('2.1.311'), false)
  assert.equal(ignoresProjectSignIn('2.1.312'), true)
  assert.equal(ignoresProjectSignIn('2.1.316'), true)
})

for (const version of ['2.1.282', '2.1.311', '2.1.312', '2.1.316']) {
  test(`${version}：项目与 local 凭据按版本归属，用户层仍覆盖启动环境`, () => {
    const f = fixture(version)
    try {
      f.write(f.userFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-user-token' })
      const baseline = rateLimitCredentialScope(f.project, f.launch)
      assert.ok(baseline)
      f.write(f.projectFile, {
        CLAUDE_CODE_OAUTH_TOKEN: 'fixture-project-token',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'fixture-refresh',
        CLAUDE_CODE_OAUTH_SCOPES: 'fixture-scope',
        CLAUDE_CODE_OAUTH_CLIENT_ID: 'fixture-client',
      })
      f.write(f.localFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-local-token' })
      const ignored = ignoresProjectSignIn(version)
      const scoped = rateLimitCredentialScope(f.project, f.launch)
      assert.equal(scoped === baseline, ignored)
      f.write(f.localFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-local-token-2' })
      const changedLocal = rateLimitCredentialScope(f.project, f.launch)
      assert.equal(changedLocal === scoped, ignored)
      f.write(f.userFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-user-token-2' })
      const changedUser = rateLimitCredentialScope(f.project, f.launch)
      assert.equal(changedUser === changedLocal, !ignored)
      assert.equal(
        rateLimitCredentialScope(f.project, {
          ...f.launch,
          env: { ...f.env, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-launch-token-2' },
        }),
        changedUser,
      )
      // 不把其他项目凭据一并忽略，也不借此合并不同 API key 的观测。
      f.write(f.localFile, {
        CLAUDE_CODE_OAUTH_TOKEN: 'fixture-local-token-2',
        ANTHROPIC_API_KEY: 'fixture-project-api',
      })
      assert.notEqual(rateLimitCredentialScope(f.project, f.launch), changedUser)
    } finally {
      f.close()
    }
  })
}

test('限额指纹使用 Litch 账号启动参数，命令行设置覆盖用户和项目的网关配置', () => {
  const f = fixture('2.1.316')
  try {
    const config = { providers: {}, last: null, removed: [] }
    const launch = providerLaunch(ACCOUNT_PROVIDER, null, f.env, config, {
      anthropic: 'fixture-litch-token',
    })
    const baseline = rateLimitCredentialScope(f.project, launch)
    const other = providerLaunch(ACCOUNT_PROVIDER, null, f.env, config, {
      anthropic: 'fixture-other-account',
    })
    assert.ok(baseline)
    assert.notEqual(baseline, rateLimitCredentialScope(f.project, other))
    writeFileSync(
      f.projectFile,
      JSON.stringify({
        apiKeyHelper: 'not-executed',
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'fixture-project-token',
          ANTHROPIC_API_KEY: 'fixture-gateway-key',
          ANTHROPIC_BASE_URL: 'https://fixture.invalid',
        },
      }),
    )
    assert.equal(rateLimitCredentialScope(f.project, launch), baseline)
    assert.equal(rateLimitCredentialScope(f.project, f.launch), null)
    // Litch 长期令牌放在启动环境，用户设置的同名项仍按 CLI 的实际优先级覆盖它。
    f.write(f.userFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-user-token' })
    assert.equal(
      rateLimitCredentialScope(f.project, launch),
      rateLimitCredentialScope(f.project, other),
    )
  } finally {
    f.close()
  }
})

test('CLI 原地升级会重新读取版本；无法确认版本时不认项目凭据的归属', () => {
  const f = fixture('2.1.311')
  try {
    assert.equal(hostClaudeRelease(f.env), '2.1.311')
    f.write(f.projectFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-project-token' })
    const old = rateLimitCredentialScope(f.project, f.launch)
    writeFileSync(f.cli, "process.stdout.write('2.1.312 (Claude Code)\\n')\n// 升级后的文件\n")
    assert.equal(hostClaudeRelease(f.env), '2.1.312')
    assert.notEqual(rateLimitCredentialScope(f.project, f.launch), old)
    assert.equal(
      rateLimitCredentialScope(f.project, {
        ...f.launch,
        env: {
          ...f.env,
          CHA_CLAUDE_CLI: join(f.home, 'missing'),
        },
      }),
      null,
    )
  } finally {
    f.close()
  }
})

test('未启用的项目设置不影响账号', () => {
  const f = fixture('2.1.316')
  try {
    f.write(f.projectFile, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-project-token' })
    const env = { ...f.env, CHA_CLAUDE_SETTING_SOURCES: 'user' }
    assert.equal(
      rateLimitCredentialScope(f.project, { env, flagSettings: null }),
      rateLimitCredentialScope(f.home, { env, flagSettings: null }),
    )
  } finally {
    f.close()
  }
})

test('HOME 内的同一份用户配置不误判为被忽略的项目配置', () => {
  const f = fixture('2.1.316')
  try {
    const config = join(f.home, '.claude')
    mkdirSync(config)
    f.write(join(config, 'settings.json'), { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-user-token' })
    const env = { ...f.env, CLAUDE_CONFIG_DIR: config }
    assert.ok(rateLimitCredentialScope(f.home, { env, flagSettings: null }))
  } finally {
    f.close()
  }
})
