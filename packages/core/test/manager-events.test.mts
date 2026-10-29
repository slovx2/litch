import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MANAGER_ANSWERS_TEXT,
  managerEndText,
  managerOpenText,
} from '../../protocol/src/client-tools-manager.mjs'
import {
  formatSessionEvent,
  parseSessionEvent,
  type SessionEvent,
} from '../../protocol/src/session-tree.mjs'

const events: SessionEvent[] = [
  {
    kind: 'manager-open',
    notes: [],
    manager: { managerId: 'm1', text: managerOpenText('开发第一版') },
  },
  {
    kind: 'manager-end',
    notes: [],
    manager: { managerId: 'm1', text: managerEndText('release') },
  },
  {
    kind: 'manager-answers',
    notes: [],
    manager: {
      managerId: 'm1',
      text: MANAGER_ANSWERS_TEXT,
      answers: [
        {
          decisionId: 'D-1',
          title: '先做哪个？',
          optionId: 'a',
          optionLabel: '协议',
          text: '保留 "引号"\n<!-- --> 和 </litch-session-event>。',
        },
        {
          decisionId: 'D-2',
          title: '开放题',
          optionId: null,
          optionLabel: null,
          text: '自由文字 😀',
        },
      ],
    },
  },
]

test('三种经理事件带来源且 format/parse 无损往返，保留用户后文', () => {
  for (const event of events) {
    const text = formatSessionEvent(event)
    assert.match(text, /This message is from Litch, not typed by the user/)
    assert.deepEqual(parseSessionEvent(text), { event, rest: '' })
    assert.deepEqual(parseSessionEvent(`${text}\n继续做下一项。`), {
      event,
      rest: '继续做下一项。',
    })
    assert.doesNotMatch(text, /Call litch_sessions.wrap_up/)
  }
  const answers = formatSessionEvent(events[2] as SessionEvent)
  assert.match(answers, /D-1/)
  assert.match(answers, /协议/)
  assert.match(answers, /自由文字/)
})

test('普通回报、唤醒、收尾提醒的原有消息形状保持不变', () => {
  for (const kind of ['notes', 'wake', 'remind'] as const) {
    const event: SessionEvent = { kind, notes: [] }
    assert.deepEqual(parseSessionEvent(formatSessionEvent(event)), { event, rest: '' })
  }
  assert.match(formatSessionEvent({ kind: 'remind', notes: [] }), /Call litch_sessions.wrap_up now/)
})

test('经理事件拒绝缺来源、错误载荷、kind 不一致和未知 kind，原文保留', () => {
  const malformed = [
    { kind: 'manager-open', notes: [] },
    { kind: 'manager-open', notes: [], manager: { managerId: '', text: '开场' } },
    { kind: 'manager-open', notes: [], manager: { managerId: 'm1', text: '开场', answers: [] } },
    { kind: 'manager-end', notes: [], manager: { managerId: 'm1', text: 1 } },
    { kind: 'manager-answers', notes: [], manager: { managerId: 'm1', text: '答复', answers: [] } },
    {
      kind: 'manager-answers',
      notes: [],
      manager: {
        managerId: 'm1',
        text: '答复',
        answers: [
          { decisionId: 'I-1', title: '事项', optionId: null, optionLabel: null, text: '' },
        ],
      },
    },
  ]
  for (const bad of malformed) {
    const text = `<litch-session-event kind="${bad.kind}">\n<!-- ${JSON.stringify(bad)} -->\n</litch-session-event>`
    assert.deepEqual(parseSessionEvent(text), { event: null, rest: text })
    assert.throws(() => formatSessionEvent(bad as SessionEvent), /Invalid manager/)
  }
  const good = formatSessionEvent(events[0] as SessionEvent)
  for (const bad of [
    good.replace('kind="manager-open"', 'kind="manager-end"'),
    good.replace('kind="manager-open"', 'kind="manager-delete"'),
    good.replace('<!-- {', '<!-- broken {'),
  ])
    assert.deepEqual(parseSessionEvent(bad), { event: null, rest: bad })
})
