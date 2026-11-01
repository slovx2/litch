import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type ClaudeAuthStatus, claudeAccountKind, claudeAuthStatus } from '../src/claude-auth.mjs'
import { isolatedEnv } from './fixtures/isolated-env.mjs'

test('账号判定同时核对用户凭据，API key 优先不隐藏已有账号令牌', () => {
  const home = mkdtempSync(join(tmpdir(), 'account-kind-'))
  const env = { CLAUDE_CONFIG_DIR: home }
  const status: ClaudeAuthStatus = {
    loggedIn: true,
    authMethod: 'api_key',
    apiKeySource: 'ANTHROPIC_API_KEY',
    email: null,
    orgName: null,
    subscriptionType: null,
  }
  try {
    assert.equal(claudeAccountKind(status, env), null)
    assert.equal(
      claudeAccountKind(status, { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }),
      'token',
    )
    assert.equal(claudeAccountKind({ ...status, authMethod: 'oauth_token' }, env), 'token')
    assert.equal(claudeAccountKind({ ...status, authMethod: 'claude.ai' }, env), 'login')
    assert.equal(claudeAccountKind({ ...status, apiKeySource: '/login managed key' }, env), 'login')
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-user-token' } }),
    )
    assert.equal(claudeAccountKind(status, env), 'token')
    writeFileSync(join(home, 'settings.json'), '{invalid')
    assert.equal(claudeAccountKind(status, env), null)
    assert.equal(
      claudeAccountKind(status, { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }),
      'token',
    )
    assert.equal(claudeAccountKind({ ...status, loggedIn: false, authMethod: 'none' }, env), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('真实 auth status 按账号回合的设置覆盖识别混合凭据', async () => {
  const home = mkdtempSync(join(tmpdir(), 'account-status-'))
  const settings = {
    env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '' },
    apiKeyHelper: '',
  }
  try {
    for (const tokenAt of ['none', 'env', 'user']) {
      for (const keyAt of ['env', 'user']) {
        const env = {
          ...isolatedEnv,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: home,
          HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
          ...(tokenAt === 'env' ? { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } : {}),
          ...(keyAt === 'env' ? { ANTHROPIC_API_KEY: 'fixture-key' } : {}),
        }
        writeFileSync(
          join(home, 'settings.json'),
          JSON.stringify({
            env: {
              ...(tokenAt === 'user' ? { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } : {}),
              ...(keyAt === 'user' ? { ANTHROPIC_API_KEY: 'fixture-key' } : {}),
            },
          }),
        )
        const status = await claudeAuthStatus(env, settings)
        assert.equal(
          status.authMethod,
          tokenAt === 'none' ? 'none' : 'oauth_token',
          `${tokenAt}/${keyAt}`,
        )
        assert.equal(claudeAccountKind(status, env), tokenAt === 'none' ? null : 'token')
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
