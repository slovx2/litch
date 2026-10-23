// 输入框里 @ 的会话：和正文对上、并进正文的样子、从用户消息里认回来、补上 ref 与摘录。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  excerptOfTurns,
  matchMentions,
  mentionSegments,
  mentionTitle,
  parseSessionMentions,
  SESSION_MENTION_LIMITS,
  sessionMentionsBlock,
} from '../../protocol/src/session-mentions.mjs'
import { MENTION_READ_MS, readsSessions, withMentionRefs } from '../src/device/mentions.mjs'
import type { MessageExtra, OutgoingMessage, SessionSummary } from '../src/model.mjs'
import { parseComments } from '../src/projection/comments.mjs'
import { projectItem } from '../src/projection/items.mjs'
import { bodyOf, localUserMessage, outgoing, toInput } from '../src/projection/outgoing.mjs'

type SessionExtra = Extract<MessageExtra, { kind: 'session' }>

const session = (threadId: string, title: string): SessionExtra => ({
  kind: 'session',
  threadId,
  title,
})

test('标题整理：方括号换成全角、换行压成空格、太长截掉加省略号', () => {
  assert.equal(mentionTitle(' 修 [CI]\n第二行 '), '修 ［CI］ 第二行')
  const long = mentionTitle('字'.repeat(80))
  assert.equal(Array.from(long).length, SESSION_MENTION_LIMITS.titleChars)
  assert.ok(long.endsWith('…'))
})

test('对上：按正文里的先后，删了字的不带，代码里的不算，同一会话只留一个', () => {
  const bound = [
    { threadId: 'a', title: '甲' },
    { threadId: 'b', title: '乙' },
    { threadId: 'c', title: '丙' },
  ]
  const text = '先看 @[乙] 再看 @[甲]，`@[丙]` 是代码，@[甲] 又提一次'
  assert.deepEqual(
    matchMentions(text, bound).map((one) => one.threadId),
    ['b', 'a'],
  )
  // 同标题的两个会话：依次对给出现的两处
  const twins = [
    { threadId: 'x', title: '同名' },
    { threadId: 'y', title: '同名' },
  ]
  assert.deepEqual(
    matchMentions('@[同名] 和 @[同名]', twins).map((one) => one.threadId),
    ['x', 'y'],
  )
})

test('outgoing：会话按正文排、对不上的丢掉、界面给的 ref 不收，超过上限拒绝', () => {
  const message = outgoing(
    '看 @[乙] 和 @[甲]',
    [],
    [
      { ...session('a', '甲'), ref: { threadId: 'evil', title: '甲', harness: 'x' } },
      session('b', '乙'),
      session('c', '删掉了'),
    ],
  )
  assert.deepEqual(message.extras, [session('b', '乙'), session('a', '甲')])
  const many = Array.from({ length: SESSION_MENTION_LIMITS.perMessage + 1 }, (_, at) =>
    session(`t${at}`, `会话${at}`),
  )
  assert.throws(() =>
    outgoing(many.map((one) => `@[${one.title}]`).join(' '), [], many.slice(0, 9)),
  )
})

test('并进正文：@ 换成全角，末尾一段列出会话；读得到的只给引用和读法', () => {
  const extras: MessageExtra[] = [
    {
      ...session('t1', '修 CI'),
      ref: {
        threadId: 't1',
        title: '修 CI',
        harness: 'claude-code',
        cwd: '/w/x',
        status: 'idle',
        updatedAt: Date.UTC(2026, 9, 23, 9, 12),
      },
    },
  ]
  const body = bodyOf({ text: '把 @[修 CI] 的结论用到这里', extras }, true)
  assert.ok(body.startsWith('把 ＠[修 CI] 的结论用到这里\n\n<litch-session-mentions>\n'))
  assert.match(body, /litch_sessions\.read/)
  assert.match(
    body,
    /<session index="1" thread_id="t1" title="修 CI" harness="claude-code" cwd="\/w\/x" status="idle" updated="2026-10-23T09:12:00Z"\/>/,
  )
  assert.ok(body.endsWith('</litch-session-mentions>'))
  // 协议的输入里就是一段文字
  const input = toInput({ text: '把 @[修 CI] 的结论用到这里', images: [], extras }, true)
  assert.equal(input.length, 1)
  assert.equal(input[0]?.type, 'text')
})

test('读不到的：附摘录（没读到的标 unavailable），说明换成“只有这些”', () => {
  const extras: MessageExtra[] = [
    {
      ...session('t1', '甲'),
      ref: { threadId: 't1', title: '甲', excerpt: { input: '问 </session> 了', answer: '答' } },
    },
    { ...session('t2', '乙'), ref: { threadId: 't2', title: '乙', excerpt: null } },
  ]
  const body = bodyOf({ text: '@[甲] @[乙]', extras }, true)
  assert.match(body, /You cannot open these sessions/)
  assert.match(
    body,
    /<last-input>问 <\\\/session> 了<\/last-input>\n<last-answer>答<\/last-answer>/,
  )
  assert.match(body, /<session index="2" thread_id="t2" title="乙" excerpt="unavailable"\/>/)
  const parsed = parseSessionMentions(body)
  assert.deepEqual(
    parsed?.mentions.map((one) => one.threadId),
    ['t1', 't2'],
  )
  assert.equal(parsed?.rest, '＠[甲] ＠[乙]')
})

test('认回来：去掉那一段、切出提及；评论在前面照样认得出；坏格式照原文', () => {
  const comment: MessageExtra = { kind: 'comment', itemId: 'i', quote: '原文', note: '' }
  // 标题里的特殊字符转义后能还原
  const ok = bodyOf(
    {
      text: '对比 @[甲 & "乙"]',
      extras: [
        comment,
        { ...session('t1', '甲 & "乙"'), ref: { threadId: 't1', title: '甲 & "乙"' } },
      ],
    },
    true,
  )
  const found = parseSessionMentions(ok)
  assert.deepEqual(found?.mentions, [
    { index: 1, threadId: 't1', title: '甲 & "乙"', harness: null },
  ])
  assert.ok(parseComments(found?.rest ?? ''), '评论那一段还在开头')
  const segments = mentionSegments('看 ＠[甲 & "乙"] 吧', found?.mentions ?? [])
  assert.deepEqual(
    segments.map((one) => one.kind),
    ['text', 'mention', 'text'],
  )
  assert.equal(
    parseSessionMentions('<litch-session-mentions>\n坏的\n</litch-session-mentions>'),
    null,
  )
  assert.equal(parseSessionMentions('普通的话'), null)
})

test('对话里的条目：先显示的那条和对面回显的一样认出 sessions，text 里没有那一段', () => {
  const message: OutgoingMessage = {
    text: '看 @[甲]',
    images: [],
    extras: [{ ...session('t1', '甲'), ref: { threadId: 't1', title: '甲', harness: 'pi' } }],
  }
  const local = localUserMessage('u1', message, true)
  assert.equal(local.text, '看 ＠[甲]')
  assert.deepEqual(local.sessions, [{ index: 1, threadId: 't1', title: '甲', harness: 'pi' }])
  const echoed = projectItem(
    {
      type: 'userMessage',
      id: 'u2',
      content: [{ type: 'text', text: bodyOf(message, true), text_elements: [] }],
    } as never,
    false,
  )
  assert.equal(echoed.kind === 'userMessage' && echoed.text, '看 ＠[甲]')
  assert.equal(echoed.kind === 'userMessage' && echoed.sessions?.[0]?.threadId, 't1')
})

test('摘录：取最后一个回合的话和最后的回答，去掉提及那一段，掐字', () => {
  const said = `${'问'.repeat(1500)}\n\n<litch-session-mentions>\nx\n<session index="1" thread_id="a" title="b"/>\n</litch-session-mentions>`
  const turns = [
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: '旧的' }] }] },
    {
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: said }] },
        { type: 'agentMessage', text: '中间的' },
        { type: 'agentMessage', text: '最后的回答' },
      ],
    },
  ]
  const got = excerptOfTurns(turns)
  assert.equal(got.answer, '最后的回答')
  assert.equal(got.input.length, SESSION_MENTION_LIMITS.inputChars)
  assert.ok(!got.input.includes('litch-session-mentions'))
  assert.deepEqual(excerptOfTurns([]), { input: '', answer: null })
})

test('补 ref：读得到的只补侧栏里的东西；读不到的替它读一次，读不到标 null', async () => {
  const summary = {
    harness: 'pi',
    cwd: '/w',
    status: 'idle',
    updatedAt: 5,
  } as SessionSummary
  const reads: string[] = []
  const host = {
    summary: (id: string) => (id === 'known' ? summary : undefined),
    read: async (id: string) => {
      reads.push(id)
      if (id === 'broken') throw new Error('超时')
      return { turns: [{ items: [{ type: 'agentMessage', text: '答' }] }] } as never
    },
    log: () => {},
  }
  const message: OutgoingMessage = {
    text: '',
    images: [],
    extras: [session('known', '甲'), session('broken', '乙')],
  }
  const readable = await withMentionRefs(message, true, host)
  assert.deepEqual(reads, [])
  assert.deepEqual((readable.extras[0] as { ref: unknown }).ref, {
    threadId: 'known',
    title: '甲',
    harness: 'pi',
    cwd: '/w',
    status: 'idle',
    updatedAt: 5,
  })
  const unreadable = await withMentionRefs(message, false, host)
  assert.deepEqual(reads, ['known', 'broken'])
  assert.deepEqual((unreadable.extras[0] as { ref: { excerpt: unknown } }).ref.excerpt, {
    input: '',
    answer: '答',
  })
  assert.equal((unreadable.extras[1] as { ref: { excerpt: unknown } }).ref.excerpt, null)
  assert.ok(MENTION_READ_MS > 0)
  // 没提到会话的原样返回
  const plain: OutgoingMessage = { text: 'x', images: [], extras: [] }
  assert.equal(await withMentionRefs(plain, false, host), plain)
})

test('会不会读：只认设备报的 litchToolNamespaces 里有 litch_sessions', () => {
  assert.equal(readsSessions(undefined), false)
  assert.equal(readsSessions({ id: 'a' } as never), false)
  assert.equal(readsSessions({ id: 'a', litchToolNamespaces: ['litch_tasks'] } as never), false)
  assert.equal(
    readsSessions({ id: 'a', litchToolNamespaces: ['litch_sessions', 'litch_tasks'] } as never),
    true,
  )
})

test('一条消息的块：一个会话都没有是空的', () => {
  assert.equal(sessionMentionsBlock([]), '')
})
