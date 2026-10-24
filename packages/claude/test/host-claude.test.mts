import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  CLAUDE_BASH_MAX_TIMEOUT_MS,
  claudeBashTimeoutEnv,
  hostClaudeExecutable,
  hostClaudeVersion,
} from '../src/host-claude.mjs'

test('宿主 CLI 使用显式路径或 PATH，拒绝缺失和低于下限的版本，诊断保留独立配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-claude-'))
  const cli = join(root, 'fixed-cli')
  const config = join(root, 'isolated-config')
  try {
    await writeFile(
      cli,
      '#!/bin/sh\n[ "$CLAUDE_CONFIG_DIR" = "$EXPECTED_CONFIG" ] || exit 7\nprintf "2.1.282 (Claude Code)\\n"\n',
      { mode: 0o700 },
    )
    await symlink(cli, join(root, 'claude'))
    assert.equal(hostClaudeExecutable({ PATH: root }), await realpath(cli))
    assert.equal(hostClaudeExecutable({ CHA_CLAUDE_CLI: cli, PATH: '' }), await realpath(cli))
    assert.throws(
      () => hostClaudeExecutable({ PATH: '', CHA_CLAUDE_CLI: join(root, 'missing') }),
      /宿主 Claude CLI/,
    )
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      CHA_CLAUDE_CLI: cli,
      CLAUDE_CONFIG_DIR: config,
      EXPECTED_CONFIG: config,
    }
    const output = execFileSync(
      process.execPath,
      [resolve('packages/claude/dist/claude/src/adapter.mjs'), '--runtime-info'],
      { env, encoding: 'utf8' },
    )
    // 版本三件套（runtime/info 回的是同一份）：对齐的 codex 协议版本、Agent SDK 版本、宿主 CLI 版本
    const info = JSON.parse(output)
    assert.equal(info.cliBuild, '2.1.282 (Claude Code)')
    const versions = JSON.parse(await readFile(resolve('protocol/versions.json'), 'utf8'))
    assert.equal(info.protocolVersion, versions.codexProtocol)
    assert.equal(info.sdkVersion, versions.claudeAgentSdk)
    await writeFile(cli, '#!/bin/sh\nprintf "2.1.283 (Claude Code)\\n"\n', { mode: 0o700 })
    assert.equal(hostClaudeVersion(cli, '2.1.282'), '2.1.283 (Claude Code)')
    await writeFile(cli, '#!/bin/sh\nprintf "2.1.281 (Claude Code)\\n"\n', { mode: 0o700 })
    assert.throws(() => hostClaudeVersion(cli, '2.1.282'), /需要 >= 2.1.282.*实际 2.1.281/)
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [resolve('packages/claude/dist/claude/src/adapter.mjs'), '--runtime-info'],
          {
            env,
            stdio: 'pipe',
          },
        ),
      /版本不符/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('后台命令上限：没写 BASH_MAX_TIMEOUT_MS 时给 24 小时，用户写了的照它', () => {
  assert.equal(CLAUDE_BASH_MAX_TIMEOUT_MS, '86400000')
  assert.deepEqual(claudeBashTimeoutEnv({ PATH: '/bin' }), { BASH_MAX_TIMEOUT_MS: '86400000' })
  assert.deepEqual(claudeBashTimeoutEnv({ BASH_MAX_TIMEOUT_MS: ' ' }), {
    BASH_MAX_TIMEOUT_MS: '86400000',
  })
  assert.deepEqual(claudeBashTimeoutEnv({ BASH_MAX_TIMEOUT_MS: '3600000' }), {})
  // 默认超时不动
  assert.equal(
    'BASH_DEFAULT_TIMEOUT_MS' in claudeBashTimeoutEnv({ BASH_DEFAULT_TIMEOUT_MS: '1000' }),
    false,
  )
})
