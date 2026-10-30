// 只用合成凭据，确认隔离副本不带个人自动执行入口。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareEnvironment } from './environment.mjs'

test('实测只复制模型连接与认证，不带 notify、MCP、插件、项目和技能', () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-cu-env-test-'))
  try {
    const source = join(root, 'source'),
      run = join(root, 'run')
    mkdirSync(source)
    const config = [
      'model_provider = "fixture"',
      'notify = ["unsafe-personal-hook"]',
      `model_catalog_json = ${JSON.stringify(join(source, 'models.json'))}`,
      '[model_providers.fixture]',
      'name = "Fixture"',
      'base_url = "http://127.0.0.1:1"',
      '[mcp_servers.personal]',
      'command = "must-not-run"',
      '[plugins.personal]',
      'enabled = true',
      '[projects."/private/project"]',
      'trust_level = "trusted"',
    ].join('\n')
    writeFileSync(join(source, 'config.toml'), config)
    writeFileSync(join(source, 'auth.json'), '{"synthetic":true}')
    writeFileSync(join(source, 'models.json'), '{}')
    const env = prepareEnvironment(run, source, 'gpt-6-astra')
    assert.notEqual(env.HOME, process.env.HOME)
    assert.equal(env.CODEX_HOME, join(run, 'codex'))
    const copied = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8')
    assert.match(copied, /model = "gpt-6-astra"/)
    assert.match(copied, /model_providers.fixture/)
    assert.match(copied, /notify = \[\]/)
    assert.doesNotMatch(copied, /unsafe-personal-hook|must-not-run|plugins|projects|trust_level/)
    assert.equal(readFileSync(join(env.CODEX_HOME, 'auth.json'), 'utf8'), '{"synthetic":true}')
    assert.equal(readFileSync(join(source, 'config.toml'), 'utf8'), config)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
