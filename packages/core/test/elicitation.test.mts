import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalRequest, FormRequest } from '../src/model.mjs'
import { projectRequest } from '../src/projection/requests.mjs'

const METHOD = 'mcpServer/elicitation/request'
const base = { threadId: 't', turnId: 'turn-1', serverName: 'tracker' }

test('征询：带着工具调用标记的是一次审批，能记住多久看请求里声明了什么', () => {
  const pending = projectRequest(
    METHOD,
    {
      ...base,
      mode: 'form',
      message: '允许运行“新建工单”吗？',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_title: '新建工单',
        tool_params: { title: '多返回一条' },
      },
    },
    'r1',
  )
  assert.ok(pending)
  const view = pending.view as ApprovalRequest
  assert.equal(view.kind, 'approval')
  assert.equal(view.subject, 'tool')
  assert.equal(view.reason, '允许运行“新建工单”吗？')
  assert.deepEqual(view.tool, {
    server: 'tracker',
    title: '新建工单',
    note: null,
    params: '{\n  "title": "多返回一条"\n}',
  })
  assert.deepEqual(
    view.options.map((option) => option.role),
    ['accept', 'acceptSession', 'acceptAlways', 'decline', 'cancel'],
  )
  assert.deepEqual(pending?.answer({ optionId: 'accept' }), {
    action: 'accept',
    content: {},
    _meta: null,
  })
  assert.deepEqual(pending?.answer({ optionId: 'acceptAlways' }), {
    action: 'accept',
    content: {},
    _meta: { persist: 'always' },
  })
  assert.deepEqual(pending?.answer({ optionId: 'decline' }), {
    action: 'decline',
    content: null,
    _meta: null,
  })
  assert.equal(pending?.answer({ optionId: 'nope' }), null)

  // 只声明了“这个会话里”：没有“以后都允许”这个按钮
  const once = projectRequest(
    METHOD,
    {
      ...base,
      mode: 'form',
      message: '',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' },
    },
    'r2',
  )
  assert.ok(once)
  assert.deepEqual(
    (once.view as ApprovalRequest).options.map((option) => option.role),
    ['accept', 'acceptSession', 'decline', 'cancel'],
  )
})

test('征询：表单按栏目的种类变成输入项；答复时没填的可选项不带，填得不对的不发', () => {
  const pending = projectRequest(
    METHOD,
    {
      ...base,
      serverName: 'deploy',
      mode: 'form',
      message: '确认几项设置',
      _meta: null,
      requestedSchema: {
        type: 'object',
        required: ['region', 'replicas'],
        properties: {
          region: {
            type: 'string',
            title: '区域',
            oneOf: [
              { const: 'ap-east', title: '香港' },
              { const: 'us-west', title: '美西' },
            ],
          },
          replicas: { type: 'integer', default: 2, minimum: 1, maximum: 20 },
          notify: { type: 'string', format: 'email', description: '留空就不发', maxLength: 6 },
          migrate: { type: 'boolean' },
          checks: { type: 'array', items: { type: 'string', enum: ['smoke', 'e2e'] } },
          tier: { type: 'string', enum: ['a', 'b'], enumNames: ['甲', '乙'] },
        },
      },
    },
    'r1',
  )
  assert.ok(pending)
  const view = pending.view as FormRequest
  assert.equal(view.kind, 'form')
  assert.equal(view.server, 'deploy')
  assert.deepEqual(
    view.fields.map((field) => [field.id, field.kind, field.required]),
    [
      ['region', 'choice', true],
      ['replicas', 'integer', true],
      ['notify', 'text', false],
      ['migrate', 'boolean', false],
      ['checks', 'choices', false],
      ['tier', 'choice', false],
    ],
  )
  assert.equal(view.fields[0]?.label, '区域')
  assert.deepEqual(view.fields[0]?.options[1], { value: 'us-west', label: '美西' })
  assert.equal(view.fields[1]?.initial, 2)
  assert.equal(view.fields[2]?.format, 'email')
  // 对面定的范围带到了栏目上；没定的是 null
  assert.deepEqual(view.fields[1]?.limits, { min: 1, max: 20, minLength: null, maxLength: null })
  assert.deepEqual(view.fields[2]?.limits, { min: null, max: null, minLength: null, maxLength: 6 })
  assert.deepEqual(view.fields[0]?.limits, {
    min: null,
    max: null,
    minLength: null,
    maxLength: null,
  })
  assert.deepEqual(view.fields[5]?.options, [
    { value: 'a', label: '甲' },
    { value: 'b', label: '乙' },
  ])

  const accept = (values: Record<string, unknown>) =>
    pending?.answer({ optionId: 'accept', values })
  assert.deepEqual(
    accept({ region: 'us-west', replicas: 3, notify: '', migrate: false, checks: [] }),
    {
      action: 'accept',
      content: { region: 'us-west', replicas: 3, migrate: false },
      _meta: null,
    },
  )
  // 必填的没填、数不是整数、选了没有的选项：都不发
  assert.equal(accept({ replicas: 3 }), null)
  assert.equal(accept({ region: 'us-west', replicas: 1.5 }), null)
  assert.equal(accept({ region: 'mars', replicas: 1 }), null)
  assert.equal(accept({ region: 'us-west', replicas: 1, checks: ['smoke', 'nope'] }), null)
  // 出了对面定的范围的：也不发（对面会拒掉，而且不给用户回音）。长度按字数算
  assert.equal(accept({ region: 'us-west', replicas: 0 }), null)
  assert.equal(accept({ region: 'us-west', replicas: 21 }), null)
  assert.equal(accept({ region: 'us-west', replicas: 20, notify: 'a@b.com' }), null)
  assert.deepEqual(accept({ region: 'us-west', replicas: 20, notify: '一二三四五六' }), {
    action: 'accept',
    content: { region: 'us-west', replicas: 20, notify: '一二三四五六' },
    _meta: null,
  })
  assert.deepEqual(pending?.answer({ optionId: 'cancel' }), {
    action: 'cancel',
    content: null,
    _meta: null,
  })
})

test('征询：去网页上办的事只给普通网址打开；认不出的种类和栏目不接', () => {
  const link = (url: string) => {
    const pending = projectRequest(
      METHOD,
      { ...base, mode: 'url', message: '去登录', url, elicitationId: 'e', _meta: null },
      'r',
    )
    assert.ok(pending)
    return (pending.view as FormRequest).link
  }
  assert.deepEqual(link('https://example.com/login?x=1'), {
    url: 'https://example.com/login?x=1',
    openable: true,
  })
  assert.equal(link('file:///etc/passwd')?.openable, false)
  assert.equal(link('javascript:alert(1)')?.openable, false)
  assert.equal(link('https://user:pw@example.com/')?.openable, false)
  assert.equal(link('https://evil.example\\@good.example/')?.openable, false)

  const form = (extra: object) =>
    projectRequest(METHOD, { ...base, mode: 'form', message: '', _meta: null, ...extra }, 'r')
  // 嵌套的对象不是 MCP 规定的简单栏目：整张不接
  assert.equal(
    form({ requestedSchema: { type: 'object', properties: { a: { type: 'object' } } } }),
    null,
  )
  // 别的带特权标记的征询不当成普通的表
  assert.equal(
    form({
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'browser_auth' },
    }),
    null,
  )
  assert.equal(projectRequest(METHOD, { ...base, mode: 'openai/form', message: '' }, 'r'), null)
  // 一栏都没有的表就是一句确认
  const confirm = form({ requestedSchema: { type: 'object', properties: {} } })
  assert.ok(confirm)
  assert.deepEqual((confirm.view as FormRequest).fields, [])
  assert.deepEqual(confirm.answer({ optionId: 'accept' }), {
    action: 'accept',
    content: {},
    _meta: null,
  })
})
