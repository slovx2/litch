import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claudeBackendMode } from '../src/tui-config.mjs'
import { tuiHook } from '../src/tui-hooks.mjs'

test('TUI 设置每次读取，默认 SDK；无效设置不静默回落', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tui-config-')), 'settings.json')
  const env = { CHA_CLAUDE_BACKEND_SETTINGS: path }
  assert.equal(claudeBackendMode(env), 'sdk')
  writeFileSync(path, JSON.stringify({ values: { 'harness.claude-code.backend': 'tui' } }))
  assert.equal(claudeBackendMode(env), 'tui')
  writeFileSync(path, JSON.stringify({ values: { 'harness.claude-code.backend': 'sdk' } }))
  assert.equal(claudeBackendMode(env), 'sdk')
  writeFileSync(path, '{bad')
  assert.throws(() => claudeBackendMode(env), /无法读取/)
  assert.throws(() => claudeBackendMode({ CHA_CLAUDE_BACKEND_MODE: 'auto' }), /必须/)
})

test('TUI 先执行全部前置检查再审批，输入改写和拒绝不能丢', async () => {
  const order: string[] = []
  const event = {
    hook_event_name: 'PreToolUse',
    tool_use_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: 'raw' },
  }
  const options = {
    abortController: new AbortController(),
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async () => {
              order.push('pre')
              return { hookSpecificOutput: { updatedInput: { command: 'sandbox' } } }
            },
          ],
        },
      ],
    },
    canUseTool: async (_name: string, input: unknown) => {
      order.push('approve')
      assert.deepEqual(input, { command: 'sandbox' })
      return { behavior: 'allow', updatedInput: input }
    },
  }
  const result = await tuiHook(options, event, () => {})
  assert.deepEqual(order, ['pre', 'approve'])
  assert.deepEqual(result.hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { command: 'sandbox' },
  })
  options.hooks.PreToolUse[0]!.hooks = [
    async () => {
      throw new Error('桥不可用')
    },
  ]
  await assert.rejects(
    tuiHook(options, event, () => {}),
    /桥不可用/,
  )
  assert.deepEqual(order, ['pre', 'approve'])
})

test('TUI 禁用后台和子代理，原生额外审批不在隐藏终端等待', async () => {
  const options = {
    abortController: new AbortController(),
    canUseTool: () => assert.fail('不能请求授权'),
  }
  for (const tool of [
    'Agent',
    'Task',
    'Workflow',
    'Monitor',
    'SendMessage',
    'EnterPlanMode',
    'ExitPlanMode',
  ]) {
    const result = await tuiHook(
      options,
      { hook_event_name: 'PreToolUse', tool_name: tool },
      () => {},
    )
    assert.equal((result.hookSpecificOutput as any).permissionDecision, 'deny')
  }
  const background = await tuiHook(
    options,
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { run_in_background: true } },
    () => {},
  )
  assert.equal((background.hookSpecificOutput as any).permissionDecision, 'deny')
  const permission = await tuiHook(options, { hook_event_name: 'PermissionRequest' }, () => {})
  assert.equal((permission.hookSpecificOutput as any).decision.behavior, 'deny')
})

test('TUI 的取消决定停止代理循环', async () => {
  const result = await tuiHook(
    {
      abortController: new AbortController(),
      canUseTool: async () => ({ behavior: 'deny', message: '已交接', interrupt: true }),
    },
    {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'plan',
      tool_name: 'Bash',
      tool_input: {},
    },
    () => {},
  )
  assert.equal(result.continue, false)
  assert.equal(result.stopReason, '已交接')
  assert.equal((result.hookSpecificOutput as any).permissionDecision, 'deny')
})
