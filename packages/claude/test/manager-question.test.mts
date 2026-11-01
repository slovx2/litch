import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import { managerQuestionRules } from '../../protocol/src/manager-question.mjs'
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
    cwd: '/tmp',
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
  for (const name of ['Read', 'Glob', 'Grep', ...dynamicToolCliNames(dynamicTools)])
    assert.equal(deniedTool(context, name, {}), null)
})
