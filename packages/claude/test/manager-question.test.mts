import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { managerQuestionRules, managerQuestionTools } from '../../protocol/src/manager-question.mjs'
import { dynamicToolCliNames } from '../src/dynamic-tools.mjs'
import { deniedTool } from '../src/runtime-permissions.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'

test('旁问的执行拦截优先于完全访问、计划文件、权限工具与子代理豁免', () => {
  const dynamicTools = [
    {
      ...MANAGER_TOOLS,
      instructions: managerQuestionRules('D-1'),
      tools: MANAGER_TOOLS.tools.filter((tool) => ['summary', 'get'].includes(tool.name)),
    },
  ]
  const context = {
    dynamicTools,
    cwd: '/work/project',
    sandboxMode: 'danger-full-access',
    permissionTools: true,
    goalTools: true,
    planMode: true,
  } as unknown as RuntimeTurnContext
  for (const name of [
    'Bash',
    'Write',
    'Edit',
    'Agent',
    'Task',
    'WebFetch',
    'WebSearch',
    'EnterPlanMode',
    'ExitPlanMode',
    'AskUserQuestion',
    'mcp__arbitrary__write',
    'request_permissions',
  ])
    assert.match(deniedTool(context, name, {}) ?? '', /只允许/)
  for (const name of ['Read', 'Glob', 'Grep', 'ToolSearch', ...dynamicToolCliNames(dynamicTools)])
    assert.equal(deniedTool(context, name, {}), null)
})

test('旁问会话读子集可用，旧工具表和原始会话记录的路径/符号链接均受限', () => {
  const root = mkdtempSync(join(tmpdir(), 'question-files-'))
  const old = process.env.CODEX_HOME
  try {
    const storage = join(root, 'raw')
    const project = join(root, 'project')
    mkdirSync(storage)
    mkdirSync(project)
    writeFileSync(join(storage, 'history.jsonl'), 'private')
    symlinkSync(storage, join(project, 'linked'))
    process.env.CODEX_HOME = storage
    const context = {
      cwd: project,
      dynamicTools: managerQuestionTools('D-1', 'manager'),
      sandboxMode: 'danger-full-access',
    } as unknown as RuntimeTurnContext
    for (const name of dynamicToolCliNames(context.dynamicTools))
      assert.equal(deniedTool(context, name, {}), null)
    for (const name of dynamicToolCliNames([SESSION_TOOLS])) {
      if (!dynamicToolCliNames(context.dynamicTools).has(name))
        assert.match(
          deniedTool(
            { ...context, dynamicTools: [...context.dynamicTools!, SESSION_TOOLS] },
            name,
            {},
          ) ?? '',
          /只允许/,
        )
    }
    assert.equal(deniedTool(context, 'Read', { file_path: join(project, 'source.mts') }), null)
    for (const path of [join(storage, 'history.jsonl'), join(project, 'linked', 'history.jsonl')])
      assert.match(deniedTool(context, 'Read', { file_path: path }) ?? '', /会话存储/)
    assert.match(deniedTool(context, 'Grep', { path: root, pattern: 'private' }) ?? '', /会话存储/)
    assert.match(deniedTool(context, 'Glob', { path: project, pattern: '../raw/*' }) ?? '', /扩大/)
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('计划和只读可发现工具，但发现不会豁免实际写入或外部 MCP', () => {
  for (const planMode of [true, false]) {
    const context = {
      cwd: '/tmp',
      threadId: 'fixture-plan-discovery',
      dynamicTools: [],
      sandboxMode: 'read-only',
      planMode,
    } as unknown as RuntimeTurnContext
    assert.equal(
      deniedTool(context, 'ToolSearch', { query: 'select:Write,mcp__external__write' }),
      null,
    )
    assert.ok(deniedTool(context, 'Write', { file_path: '/tmp/not-allowed.txt' }))
    assert.ok(deniedTool(context, 'mcp__external__write', {}))
  }
})
