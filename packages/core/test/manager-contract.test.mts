// 只验协议、提示词与模型工具参数，不启动设备或连接模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ajv2019 } from 'ajv/dist/2019.js'
import extension from '../../../protocol/extensions/manager.json' with { type: 'json' }
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import {
  MANAGER_TOOL,
  MANAGER_TOOLS,
  managerEndText,
  managerLineRules,
  managerOpenText,
  managerRoleRules,
  managerSessionRules,
} from '../../protocol/src/client-tools-manager.mjs'
import {
  archiveRule,
  FRESH_BRIEF,
  outsideLitch,
  TITLE_LINE,
  WORKTREE_RULE,
} from '../../protocol/src/client-tools-sessions.mjs'
import { clientToolSpec } from '../../protocol/src/client-tools-specs.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  MANAGER_NOTIFICATION,
  type ManagerAnswersSubmitResponse,
  type ManagerBoard,
  type ManagerCreateParams,
  type ManagerDecision,
} from '../../protocol/src/manager.mjs'
import { dynamicToolProblems } from '../../shared/test/codex-params.mjs'

const ajv = new Ajv2019({ strict: false, allErrors: true })
const definitions = extension.definitions
const validate = (name: keyof typeof definitions, data: unknown): boolean => {
  const check = ajv.compile({ $ref: `#/definitions/${name}`, definitions })
  return check(data) as boolean
}

const decision: ManagerDecision = {
  id: 'D-1',
  revision: 1,
  title: '先做哪一项？',
  background: '需要用户排顺序。',
  options: [{ id: 'a', label: '协议', description: '先定契约' }],
  recommend: 'a',
  default: { kind: 'ask' },
  blocks: ['I-1'],
  links: [],
  basis: [{ kind: 'file', target: 'AGENTS.md', label: null }],
  landed: [],
  status: 'open',
  checked: null,
  answer: null,
  closed: null,
  createdAt: 100,
  updatedAt: 100,
}

test('扩展、方法和通知登记与声明完全一致', () => {
  assert.equal(extension.extension, EXTENSION.manager)
  assert.deepEqual(
    extension.parts.filter((part) => part.kind === 'ClientRequest').map((part) => part.method),
    Object.values(MANAGER_METHOD),
  )
  assert.deepEqual(
    extension.parts.filter((part) => part.kind === 'ServerNotification').map((part) => part.method),
    Object.values(MANAGER_NOTIFICATION),
  )
  assert.match(extension.undeclared, /extensionRequired/)
  assert.match(extension.undeclared, /不带 litchManager/)
  // 每个定义都能编译，保证嵌套 $ref 不悬空。
  for (const name of Object.keys(definitions))
    assert.doesNotThrow(() => ajv.compile({ $ref: `#/definitions/${name}`, definitions }))
})

test('创建形状覆盖设置，第一版不收手机或截止执行字段', () => {
  const params: ManagerCreateParams = {
    cwd: '/repo',
    harness: 'codex',
    model: null,
    effort: null,
    name: '',
    scope: '完成版本',
    template: 'release',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    firstTask: '',
  }
  assert.equal(validate('CreateParams', params), true)
  assert.equal(validate('CreateParams', { ...params, scope: '' }), false)
  assert.equal(validate('Dispatch', { ...params.dispatch, maxRunningLines: 0 }), false)
  assert.equal(validate('Dispatch', { ...params.dispatch, maxRunningLines: 1.5 }), false)
  assert.equal(validate('Contact', { ...params.contact, pushPhone: true }), false)
  assert.equal(validate('Contact', { ...params.contact, unanswered: 'recommend' }), false)
  assert.equal(validate('Decision', { ...decision, due: 300 }), false)
  assert.equal(validate('Decision', { ...decision, status: 'defaulted' }), false)
})

test('决策、看板与部分成功答复的类型和 schema 对齐', () => {
  const board: ManagerBoard = {
    managerId: 'm1',
    situation: { text: '等待排顺序', at: 100 },
    decisions: [decision],
    items: [],
    lines: [],
    activities: [],
    changes: [],
  }
  const result: ManagerAnswersSubmitResponse = {
    accepted: [
      {
        ...decision,
        revision: 2,
        status: 'answered',
        answer: { optionId: 'a', text: '', by: 'user', at: 101 },
      },
    ],
    rejected: [
      {
        decisionId: 'D-2',
        code: 'decisionConflict',
        message: 'Review the updated decision.',
        decision: { ...decision, id: 'D-2' },
      },
    ],
    delivery: 'queued',
  }
  assert.equal(validate('Board', board), true)
  assert.equal(validate('AnswersResponse', result), true)
  assert.equal(validate('SubmittedAnswer', { decisionId: 'D-1', optionId: 'a', text: '' }), false)
  assert.equal(validate('AnswersParams', { managerId: 'm1', answers: [] }), false)
  assert.equal(validate('Decision', { ...decision, id: 'I-1' }), false)
  assert.equal(validate('Owner', { kind: 'line' }), false)
  assert.equal(validate('SessionManagerMark', { managerId: 'm1', role: 'line' }), true)
  assert.equal(validate('SessionManagerMark', { managerId: 'm1', role: 'ordinary' }), false)
})

test('经理工具登记完整，通过原生 Codex 约束，命名空间说明不超过 1024 字', () => {
  assert.equal(clientToolSpec(CLIENT_TOOL_NAMESPACE.manager), MANAGER_TOOLS)
  assert.deepEqual(
    MANAGER_TOOLS.tools.map((tool) => tool.name),
    Object.values(MANAGER_TOOL),
  )
  assert.deepEqual(dynamicToolProblems([MANAGER_TOOLS]), [])
  assert.ok([...MANAGER_TOOLS.description].length <= 1024)
})

test('工具 schema 区分决策与事项，拒绝写系统字段、工作线和跨板 id', () => {
  const cases: Record<string, { valid: unknown; invalid: unknown[] }> = {
    summary: { valid: {}, invalid: [{ managerId: 'other' }] },
    get: { valid: { id: 'D-1' }, invalid: [{}] },
    add: {
      valid: { kind: 'decision', decision: { title: '问题', background: '背景' } },
      invalid: [
        { kind: 'line', line: {} },
        { kind: 'item', item: { title: '事项', checked: { at: 1 } } },
      ],
    },
    update: {
      valid: {
        kind: 'item',
        id: 'I-1',
        patch: { status: 'review', owner: { kind: 'line', threadId: 't1' } },
        why: '回报到了',
      },
      invalid: [
        { kind: 'decision', id: 'D-1', patch: { status: 'answered' }, why: '不能绕过 answer' },
        { kind: 'item', id: 'I-1', patch: { revision: 4 }, why: '系统字段' },
      ],
    },
    verify: {
      valid: { id: 'D-1', commit: null, why: '查过了' },
      invalid: [{ id: 'D-1', commit: null }],
    },
    close: {
      valid: { kind: 'decision', id: 'D-1', status: 'withdrawn', reason: '已不需要' },
      invalid: [
        { kind: 'decision', id: 'D-1', status: 'done', reason: '错误种类' },
        { kind: 'decision', id: 'D-1', status: 'expired' },
      ],
    },
    answer: {
      valid: { id: 'D-1', optionId: null, text: '先做协议' },
      invalid: [{ id: 'D-1', optionId: null, text: '先做协议', by: 'manager' }],
    },
    status: { valid: { text: '等验收' }, invalid: [{ text: '等验收', at: 10 }] },
  }
  for (const tool of MANAGER_TOOLS.tools) {
    const check = ajv.compile(tool.inputSchema)
    const sample = cases[tool.name]
    assert.ok(sample)
    assert.equal(check(sample.valid), true, `${tool.name}: ${ajv.errorsText(check.errors)}`)
    for (const invalid of sample.invalid) assert.equal(check(invalid), false, tool.name)
  }
})

test('角色规则保持预算和第一版边界，会话版原样复用共用规则', () => {
  const role = managerRoleRules('scope-token')
  // 4000 英文字符约为稿中 800 token 预算；实际分词随 harness 而异。
  assert.ok(role.length < 4000, String(role.length))
  assert.match(role, /scope-token/)
  assert.match(role, /Do not implement code yourself/)
  assert.match(role, /Check the recorded basis before acting/)
  assert.match(role, /Use verify after checking that an object remains valid/)
  assert.match(role, /only the user can do/)
  const sessions = managerSessionRules(4)
  for (const shared of [
    FRESH_BRIEF,
    WORKTREE_RULE,
    TITLE_LINE,
    archiveRule(false),
    outsideLitch(false),
  ])
    assert.ok(sessions.includes(shared))
  assert.match(sessions, /at most 4 lines/)
  assert.match(sessions, /including event turns/)
  assert.match(sessions, /Do not call wrap_up/)
  assert.doesNotMatch(sessions, /initiation "propose"|initiation "offer"/)
})

test('线的回报和首次、结束回合遵守草稿约束', () => {
  const line = managerLineRules('版本经理', MANAGER_DEFAULT_DISPATCH)
  assert.match(line, /版本经理/)
  assert.match(line, /没验：/)
  assert.match(line, /Do not merge, push or release/)
  assert.match(line, /do not inherit litch_manager/)
  assert.match(managerOpenText('范围'), /Do not start lines yet/)
  assert.match(managerOpenText('范围', '  '), /Do not start lines yet/)
  const first = '立即调研\n保留原文'
  assert.ok(managerOpenText('范围', first).endsWith(first))
  assert.doesNotMatch(managerOpenText('范围', first), /Do not start lines yet/)
  assert.match(managerEndText('release'), /draft of release notes/)
  assert.doesNotMatch(managerEndText('blank'), /draft of release notes/)
  assert.match(managerEndText('blank'), /without explicit agreement/)
})
