// 用真实 SDK 读取隔离的原生 jsonl，覆盖 wind 的 queued_command 答复与会话消息。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { askReplyText } from '../../protocol/src/async-asks.mjs'
import { projectNativeHistory } from '../src/native-history.mjs'
import { CLAUDE_REMINDERS } from '../src/system-reminders.mjs'

const config = await mkdtemp(join(tmpdir(), 'answer-history-'))
process.env.CLAUDE_CONFIG_DIR = config
test.after(() => rm(config, { recursive: true, force: true }))
const { sdkNativeSessionSource } = await import('../src/native-sessions.mjs')
const cwd = '/work/answer-history'
const dir = join(config, 'projects', '-work-answer-history')

test('SDK 重读 CLI 附件形状：系统提醒不成为正文，助手复述只去已知前缀', async () => {
  const sessionId = '1972ac1a-e630-4dde-b7ef-d46110598b2d'
  const common = { sessionId, cwd, isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z' }
  const rows = [
    {
      ...common,
      type: 'user',
      uuid: 'start',
      parentUuid: null,
      message: { role: 'user', content: '虚构任务' },
    },
    {
      ...common,
      type: 'attachment',
      uuid: 'reminder',
      parentUuid: 'start',
      attachment: { type: 'todo_reminder', content: [], itemCount: 0 },
      renderedRole: 'system',
      rendered: [{ content: `<system-reminder>\n${CLAUDE_REMINDERS[0]}\n</system-reminder>` }],
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'answer',
      parentUuid: 'reminder',
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: `${CLAUDE_REMINDERS[0]}\n\n正常回答` }],
      },
    },
  ]
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${sessionId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n'),
  )
  const messages = await sdkNativeSessionSource().messages(sessionId, cwd)
  assert.equal(
    messages.some((m) => m.uuid === 'reminder'),
    false,
    'SDK 已过滤系统附件',
  )
  assert.ok(JSON.stringify(messages).includes(CLAUDE_REMINDERS[0]), '助手原样复述仍在 SDK 输出里')
  const result = projectNativeHistory(sessionId, messages, cwd)
  assert.deepEqual(
    result.turns[0]?.items.filter((i) => i.type === 'agentMessage').map((i) => i.text),
    ['正常回答'],
  )
})

test('SDK 重读虚构 refusal 原生记录后保留停止原因，历史投影为失败', async () => {
  const sessionId = '1972ac1a-e630-4dde-b7ef-d46110598b2c'
  const common = { sessionId, cwd, isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z' }
  const rows = [
    {
      ...common,
      type: 'user',
      uuid: 'sample-user',
      parentUuid: null,
      message: { role: 'user', content: '虚构任务' },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'sample-refusal',
      parentUuid: 'sample-user',
      isApiErrorMessage: true,
      error: 'invalid_request',
      message: {
        role: 'assistant',
        stop_reason: 'refusal',
        content: [{ type: 'text', text: 'API Error: Example safeguards flagged this message.' }],
      },
    },
  ]
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${sessionId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n'),
  )
  for (let i = 0; i < 2; i++) {
    const messages = await sdkNativeSessionSource().messages(sessionId, cwd)
    const result = projectNativeHistory(sessionId, messages, cwd)
    assert.equal(result.turns.at(-1)?.status, 'failed')
    assert.match(JSON.stringify(result.turns.at(-1)?.error), /Blocked by Claude safety policy/)
  }
})
const answer = askReplyText([
  {
    questionItemId: '["wrap_up","old:question"]',
    question: '下一步做什么？',
    answer: '先练级和做其他事情',
  },
])
const peer = '[Litch] Message from session "基建" (other), not typed by the user:\n\n补齐证据'

for (const reversed of [false, true])
  test(`原生历史：答复${reversed ? '晚于' : '早于'}会话消息，重读不丢失也不合并`, async () => {
    const sessionId = `1972ac1a-e630-4dde-b7ef-d46110598b2${reversed ? 'a' : 'b'}`
    const rows: Record<string, unknown>[] = []
    const add = (uuid: string, type: string, fields: Record<string, unknown>) => {
      rows.push({
        uuid,
        type,
        parentUuid: rows.at(-1)?.uuid ?? null,
        sessionId,
        cwd,
        isSidechain: false,
        timestamp: '2026-11-03T10:00:00.000Z',
        ...fields,
      })
    }
    add('start', 'user', { message: { role: 'user', content: '继续任务' } })
    add('question', 'assistant', {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'question',
            name: 'mcp__litch_sessions__wrap_up',
            input: { suggestions: [], ask: '下一步做什么？' },
          },
        ],
      },
    })
    add('result', 'user', {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'question', content: '已显示问题' }],
      },
    })
    const messages = [
      { id: 'reply', prompt: answer },
      { id: 'peer', prompt: peer },
    ]
    for (const entry of reversed ? messages.toReversed() : messages) {
      add(`attachment-${entry.id}`, 'attachment', {
        attachment: {
          type: 'queued_command',
          prompt: entry.prompt,
          source_uuid: entry.id,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
        },
      })
    }
    add('continue', 'assistant', {
      message: { role: 'assistant', content: [{ type: 'text', text: '已记下决定，继续执行' }] },
    })
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join('\n'),
    )
    let before: unknown
    for (let read = 0; read < 2; read++) {
      const native = await sdkNativeSessionSource().messages(sessionId, cwd)
      assert.deepEqual(
        native.filter((row) => row.uuid === 'reply' || row.uuid === 'peer').map((row) => row.uuid),
        reversed ? ['peer', 'reply'] : ['reply', 'peer'],
      )
      const history = projectNativeHistory(sessionId, native, cwd)
      const texts = history.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.type === 'userMessage')
        .map((item) =>
          item.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
        )
      assert.deepEqual(texts.slice(-2), reversed ? [peer, answer] : [answer, peer])
      assert.equal(history.turns.at(-1)?.items.at(-1)?.type, 'agentMessage')
      if (read) assert.deepEqual(history, before)
      before = history
    }
  })
