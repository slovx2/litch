import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import {
  compareCliVersions,
  hostCliCandidates,
  hostCliDiagnostic,
  resolveHostCli,
} from '../../shared/src/host-cli.mjs'
import { hostClaudeExecutable } from '../src/host-claude.mjs'

test('CLI 候选按版本择优，显式命令与路径保留，原地升级刷新，别名去重', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cli-choice-')))
  const first = join(root, 'one', 'claude')
  const second = join(root, 'two', 'claude')
  const official = join(root, '.local', 'bin', 'claude')
  const count = join(root, 'probes')
  const write = async (path: string, version: string, code = 0) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `#!/bin/sh\necho probe >> '${count}'\necho '${version} (Claude Code)'\nexit ${code}\n`,
      { mode: 0o700 },
    )
  }
  const env = { HOME: root, PATH: [dirname(first), dirname(second)].join(delimiter) }
  try {
    await write(first, '2.1.287')
    await write(second, '2.1.300')
    await write(official, '2.1.318')
    assert.equal(hostClaudeExecutable(env), official)
    assert.equal(hostClaudeExecutable(env), official)
    assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 3)
    assert.equal(hostClaudeExecutable({ ...env, CHA_CLAUDE_CLI: first }), first)
    assert.equal(hostClaudeExecutable({ ...env, CHA_CLAUDE_CLI: 'claude' }), first)
    assert.match(
      hostCliDiagnostic(first, 'claude', '@anthropic-ai/claude-code', 'bin/claude.exe', env),
      /2\.1\.318.*\.local/,
    )
    await write(first, '2.1.400')
    assert.equal(hostClaudeExecutable(env), first)
    await write(second, '2.1.400')
    assert.equal(hostClaudeExecutable(env), first)
    await write(first, 'unknown')
    assert.equal(hostClaudeExecutable(env), second)
    await write(second, '9.0.0', 1)
    await write(official, 'unknown')
    assert.equal(hostClaudeExecutable(env), first)
    assert.throws(() => hostClaudeExecutable({ ...env, CHA_CLAUDE_CLI: join(root, 'missing') }))
    await writeFile(second, '#!/bin/sh\necho 2.1.500 >&2\n', { mode: 0o700 })
    assert.equal(hostClaudeExecutable(env), second)
    const alias = join(root, 'alias')
    await mkdir(alias)
    await symlink(first, join(alias, 'claude'))
    assert.equal(
      hostCliCandidates('claude', '', '', { ...env, PATH: `${env.PATH}${delimiter}${alias}` })
        .length,
      3,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('独立引擎也检查 npm 全局目录，稳定版与预发布按语义版本排序', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cli-npm-')))
  try {
    const bin = join(root, 'bin'),
      global = join(root, 'global')
    await mkdir(bin)
    await mkdir(join(global, 'bin'), { recursive: true })
    await writeFile(join(bin, 'npm'), `#!/bin/sh\necho '${global}'\n`, { mode: 0o700 })
    await writeFile(join(bin, 'pi'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o700 })
    await writeFile(join(global, 'bin', 'pi'), '#!/bin/sh\necho 2.0.0\n', { mode: 0o700 })
    assert.equal(resolveHostCli('pi', '', '', { HOME: root, PATH: bin }), join(global, 'bin', 'pi'))
    for (const [a, b] of [
      ['2.0.0', '2.0.0-rc.9'],
      ['1.0.0-rc.10', '1.0.0-rc.2'],
      ['1.0.0-a', '1.0.0-1'],
      ['1.0.0-a.1', '1.0.0-a'],
    ]) {
      assert.ok(compareCliVersions(a!, b!) > 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
