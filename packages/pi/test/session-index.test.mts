import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverSessions } from '../src/projection.mjs'

const at = (time: string) => Math.floor(Date.parse(time) / 1000)

test('Pi 会话索引：最后更新时间按最后一条消息算，扩展记的状态不算', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cha-pi-index-'))
  try {
    const lines = [
      {
        type: 'session',
        id: '11111111-1111-4111-8111-111111111111',
        cwd: '/work/app',
        timestamp: '2026-10-12T10:00:00.000Z',
      },
      {
        type: 'message',
        id: 'a',
        parentId: null,
        timestamp: '2026-10-12T10:00:01.000Z',
        message: { role: 'user', content: '第一句话' },
      },
      {
        type: 'message',
        id: 'b',
        parentId: 'a',
        timestamp: '2026-10-12T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
      },
      // 会话被打开、关闭时计划模式扩展记下的状态：比最后一条消息晚了一个多小时
      {
        type: 'custom',
        id: 'c',
        parentId: 'b',
        timestamp: '2026-10-12T11:30:00.000Z',
        customType: 'plan-mode-state',
        data: { enabled: false },
      },
    ]
    await writeFile(
      join(home, 'one.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
    // 一句话都还没说的会话：没有消息，用会话建立的时间
    await writeFile(
      join(home, 'empty.jsonl'),
      `${JSON.stringify({
        type: 'session',
        id: '22222222-2222-4222-8222-222222222222',
        cwd: '/work/app',
        timestamp: '2026-10-12T09:00:00.000Z',
      })}\n${JSON.stringify({
        type: 'custom',
        id: 'x',
        parentId: null,
        timestamp: '2026-10-12T09:45:00.000Z',
        customType: 'plan-mode-state',
        data: { enabled: false },
      })}\n`,
    )
    const found = await discoverSessions(home)
    const byId = new Map(found.map(({ thread }) => [thread.id, thread]))
    assert.equal(
      byId.get('11111111-1111-4111-8111-111111111111')?.updatedAt,
      at('2026-10-12T10:00:05.000Z'),
    )
    assert.equal(
      byId.get('22222222-2222-4222-8222-222222222222')?.updatedAt,
      at('2026-10-12T09:00:00.000Z'),
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Pi 会话索引：适配器的回合没写消息也算会话有了动静，按回合结束的时间算；没记下结束的按开始的时间', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cha-pi-index-'))
  try {
    const head = (id: string) => ({
      type: 'session',
      id,
      cwd: '/work/app',
      timestamp: '2026-10-12T10:00:00.000Z',
    })
    const said = [
      {
        type: 'message',
        id: 'a',
        parentId: null,
        timestamp: '2026-10-12T10:00:01.000Z',
        message: { role: 'user', content: '第一句话' },
      },
      {
        type: 'message',
        id: 'b',
        parentId: 'a',
        timestamp: '2026-10-12T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
      },
    ]
    const custom = (id: string, customType: string, data: unknown, timestamp: string) => ({
      type: 'custom',
      id,
      parentId: 'b',
      timestamp,
      customType,
      data,
    })
    const write = (name: string, lines: unknown[]) =>
      writeFile(join(home, name), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    // 只走了扩展命令的回合（/plan 打开菜单又跳过）：只有回合的标记和扩展记的状态，没有消息
    await write('command.jsonl', [
      head('33333333-3333-4333-8333-333333333333'),
      ...said,
      custom(
        't1',
        'codex-harness-adapter-turn',
        { id: 'codex-harness-adapter:1', startedAt: Date.parse('2026-10-12T10:20:00.000Z') },
        '2026-10-12T10:20:00.000Z',
      ),
      custom('p1', 'plan-mode-state', { enabled: false }, '2026-10-12T10:20:01.000Z'),
      custom(
        'e1',
        'codex-harness-adapter-turn-end',
        {
          id: 'codex-harness-adapter:1',
          status: 'completed',
          completedAt: Date.parse('2026-10-12T10:20:09.400Z'),
        },
        '2026-10-12T10:20:09.401Z',
      ),
      // 之后有人打开看了一眼
      custom('p2', 'plan-mode-state', { enabled: false }, '2026-10-12T11:30:00.000Z'),
    ])
    // 回合开始后适配器就退出了，没记下结束
    await write('cut.jsonl', [
      head('44444444-4444-4444-8444-444444444444'),
      ...said,
      custom(
        't2',
        'codex-harness-adapter-turn',
        { id: 'codex-harness-adapter:2', startedAt: Date.parse('2026-10-12T10:30:00.000Z') },
        '2026-10-12T10:30:00.000Z',
      ),
    ])
    const found = await discoverSessions(home)
    const byId = new Map(found.map(({ thread }) => [thread.id, thread]))
    assert.equal(
      byId.get('33333333-3333-4333-8333-333333333333')?.updatedAt,
      at('2026-10-12T10:20:09.400Z'),
    )
    assert.equal(
      byId.get('44444444-4444-4444-8444-444444444444')?.updatedAt,
      at('2026-10-12T10:30:00.000Z'),
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
