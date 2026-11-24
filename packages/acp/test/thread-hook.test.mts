import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { prefixedCommand } from '../src/thread-hook.mjs'
import { hookCommand, threadHookEnv } from '../src/thread-hook-settings.mjs'

const DEVICE = { LITCH_DEVICE_SOCKET: '/state/device.sock', LITCH_DEVICE_GITHUB_HARNESS: 'qwen' }
const posix = process.platform !== 'win32'

test('Qwen 的系统默认设置里接上会话号钩子，保留原来的内容', { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-thread-hook-'))
  try {
    const original = join(dir, 'system-defaults.json')
    writeFileSync(
      original,
      JSON.stringify({
        ui: { theme: 'x' },
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'own' }] }] },
      }),
    )
    const env = { ...DEVICE, QWEN_CODE_SYSTEM_DEFAULTS_PATH: original }
    const extra = threadHookEnv('qwen', env, dir, '/litch/thread-hook.mjs')
    const written = JSON.parse(readFileSync(extra.QWEN_CODE_SYSTEM_DEFAULTS_PATH as string, 'utf8'))
    assert.equal(written.ui.theme, 'x')
    assert.equal(written.hooks.PreToolUse.length, 2, '原来的钩子在前')
    assert.equal(written.hooks.PreToolUse[0].hooks[0].command, 'own')
    const ours = written.hooks.PreToolUse[1]
    assert.equal(ours.matcher, 'run_shell_command')
    assert.equal(
      ours.hooks[0].command,
      hookCommand([process.execPath, '/litch/thread-hook.mjs', 'qwen', '/state/device.sock']),
    )

    // 系统设置路径改过时，默认设置在它旁边；那里没有文件就从空的开始
    const moved = threadHookEnv(
      'qwen',
      { ...DEVICE, QWEN_CODE_SYSTEM_SETTINGS_PATH: join(dir, 'none', 'settings.json') },
      dir,
    )
    const fresh = JSON.parse(readFileSync(moved.QWEN_CODE_SYSTEM_DEFAULTS_PATH as string, 'utf8'))
    assert.equal(fresh.hooks.PreToolUse.length, 1)

    // 读不懂的原文件、不在设备下、别的 agent：都不挂
    writeFileSync(original, '{ // 注释\n}')
    assert.deepEqual(threadHookEnv('qwen', env, dir), {})
    assert.deepEqual(threadHookEnv('qwen', { QWEN_CODE_SYSTEM_DEFAULTS_PATH: original }, dir), {})
    assert.deepEqual(threadHookEnv('gemini', env, dir), {})
    assert.deepEqual(threadHookEnv('acp', env, dir), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('钩子命令引用路径，单引号也能原样传过去', { skip: !posix }, () => {
  const out = spawnSync(
    'bash',
    ['-c', `${hookCommand(['printf', '%s|'])} ${hookCommand(["/a b/it's", 'x'])}`],
    { encoding: 'utf8' },
  )
  assert.equal(out.stdout, "/a b/it's|x|")
})

test('命令前缀：POSIX 上写，Windows 和带特殊字符的会话号不写', () => {
  assert.equal(
    prefixedCommand('gh api /user', 's-1', 'linux'),
    "export LITCH_THREAD_ID='s-1'\ngh api /user",
  )
  assert.equal(prefixedCommand('gh', 's-1', 'win32'), null)
  assert.equal(prefixedCommand('gh', 'a b', 'linux'), null)
  assert.equal(prefixedCommand('gh', "a'b", 'darwin'), null)
})

test('钩子脚本单独跑：读不到设备照样放行', () => {
  const script = fileURLToPath(new URL('../src/thread-hook.mjs', import.meta.url))
  const out = spawnSync(process.execPath, [script, 'qwen', '/nonexistent/device.sock'], {
    input: JSON.stringify({
      session_id: 's-1',
      tool_name: 'run_shell_command',
      tool_input: { command: 'ls' },
    }),
    encoding: 'utf8',
  })
  assert.equal(out.status, 0)
  assert.equal(out.stdout, '{}')
})
