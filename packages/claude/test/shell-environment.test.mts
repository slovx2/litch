import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { sandboxedBashInput } from '../src/runtime-permissions.mjs'
import {
  resolveShellEnvironmentPolicy,
  type ShellEnvironmentPolicy,
  shellEnvironmentCommand,
} from '../src/shell-environment.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'

// 命令起来时的环境（模拟 CLI 给 Bash 的那份）
const BASE: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/u',
  LANG: 'C',
  FOO_TOKEN: 't',
  api_key: 'k',
  MY_SECRET: 's',
  KEEP: '1',
  BROWSER_MCP_BEARER_TOKEN: 'bearer',
  LITCH_THREAD_ID: 'thread-1',
}

function envAfter(command: string, base = BASE): Record<string, string> {
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    env: base,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const env: Record<string, string> = {}
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const at = entry.indexOf('=')
    env[entry.slice(0, at)] = entry.slice(at + 1)
  }
  // bash 自己会补的几个变量不算
  for (const name of ['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING']) delete env[name]
  return env
}

const run = (value: Record<string, unknown>, base = BASE) =>
  envAfter(shellEnvironmentCommand(resolveShellEnvironmentPolicy(value), '/usr/bin/env -0'), base)

test('SHELL-ENV-001：照 codex 解析 shell_environment_policy，写错了报 -32602', () => {
  assert.equal(resolveShellEnvironmentPolicy(undefined), null)
  assert.deepEqual(resolveShellEnvironmentPolicy({}), {
    inherit: 'all',
    ignoreDefaultExcludes: true,
    exclude: [],
    set: {},
    includeOnly: [],
  })
  assert.deepEqual(resolveShellEnvironmentPolicy({ filters: { 'A*': 'include', B: 'exclude' } }), {
    inherit: 'all',
    ignoreDefaultExcludes: true,
    exclude: ['B'],
    set: {},
    includeOnly: ['A*'],
  })
  for (const bad of [
    'core',
    { inherit: 'some' },
    { unknown: 1 },
    { set: { A: 1 } },
    { set: { 'A-B': 'x' } },
    { exclude: 'A' },
    { filters: { A: 'include' }, exclude: ['B'] },
    { filters: { A: 'include', a: 'exclude' } },
    { filters: { A: 'keep' } },
    { ignore_default_excludes: 'yes' },
  ])
    assert.throws(
      () => resolveShellEnvironmentPolicy(bad),
      /shell_environment_policy/,
      JSON.stringify(bad),
    )
})

test('SHELL-ENV-002：命令按 inherit、默认排除、exclude、set、include_only 组环境', () => {
  // 等于默认就不包
  assert.equal(shellEnvironmentCommand(resolveShellEnvironmentPolicy({}), 'ls'), 'ls')
  assert.equal(shellEnvironmentCommand(null, 'ls'), 'ls')
  // core：只留基本变量，set 覆盖、新增；LITCH_THREAD_ID 照留
  assert.deepEqual(
    run({ inherit: 'core', set: { PATH: '/opt/bin:/usr/bin:/bin', CLI_TOKEN: 'c' } }),
    {
      PATH: '/opt/bin:/usr/bin:/bin',
      HOME: '/home/u',
      LANG: 'C',
      CLI_TOKEN: 'c',
      LITCH_THREAD_ID: 'thread-1',
    },
  )
  // all + exclude：不分大小写，通配符
  const excluded = run({ exclude: ['browser_mcp_*', 'keep'] })
  assert.equal(excluded.BROWSER_MCP_BEARER_TOKEN, undefined)
  assert.equal(excluded.KEEP, undefined)
  assert.equal(excluded.FOO_TOKEN, 't')
  // 默认排除只在 ignore_default_excludes = false 时生效
  const defaults = run({ ignore_default_excludes: false })
  for (const name of ['FOO_TOKEN', 'api_key', 'MY_SECRET', 'BROWSER_MCP_BEARER_TOKEN'])
    assert.equal(defaults[name], undefined, name)
  assert.equal(defaults.KEEP, '1')
  // include_only 在 set 之后：set 了但不在名单里的也去掉
  assert.deepEqual(run({ set: { X1: 'a', Y1: 'b' }, include_only: ['PATH', 'x?'] }), {
    PATH: '/usr/bin:/bin',
    X1: 'a',
    LITCH_THREAD_ID: 'thread-1',
  })
  // none：只剩 set 的
  assert.deepEqual(run({ inherit: 'none', set: { ONLY: 'v' } }), {
    ONLY: 'v',
    LITCH_THREAD_ID: 'thread-1',
  })
  // 值原样（引号、换行、$），模式里的方括号按字面
  const tricky = `a'b"c\n$HOME \`x\``
  assert.equal(run({ set: { V: tricky } }).V, tricky)
  assert.equal(run({ exclude: ['K[E]EP'] }, { ...BASE, 'K[E]EP': '' }).KEEP, '1')
})

test('SHELL-ENV-003：套沙箱时先组环境再进沙箱，完全访问也照样组', () => {
  const policy = resolveShellEnvironmentPolicy({
    inherit: 'core',
    set: { CLI_TOKEN: 'c' },
  }) as ShellEnvironmentPolicy
  const context = (sandboxMode: string) =>
    ({
      threadId: 't',
      cwd: process.cwd(),
      sandboxMode,
      approvalPolicy: 'never',
      shellEnvironment: policy,
    }) as unknown as RuntimeTurnContext
  for (const mode of ['danger-full-access', 'workspace-write']) {
    if (mode !== 'danger-full-access' && process.platform !== 'darwin') continue
    const input = sandboxedBashInput(context(mode), { command: 'env -0' })
    const env = envAfter(String(input.command))
    assert.equal(env.CLI_TOKEN, 'c', mode)
    assert.equal(env.FOO_TOKEN, undefined, mode)
  }
})
