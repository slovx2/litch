// 纯合成数据：只采用数量与长度，不读取、复用任何用户记录或原文。
import type { Thread, ThreadItem, Turn } from '../../protocol/src/index.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import { projectThread } from '../src/projection/session.mjs'

export function longCommandThread() {
  const turns: Turn[] = []
  let tools = 0
  let reasoning = 0
  let events = 0
  let compactions = 0
  const text = (length: number) =>
    'synthetic measurement text. '.repeat(Math.ceil(length / 27)).slice(0, length)
  const item = <T extends ThreadItem>(value: T): T => value
  const eventText = (n: number) =>
    formatSessionEvent({
      kind: 'notes',
      notes: [
        {
          threadId: `synthetic-${n % 80}`,
          title: '合成工作线',
          status: 'completed',
          excerpt: text(1500),
        },
      ],
    })
  for (let n = 0; n < 1265; n++) {
    const items: ThreadItem[] = [
      item({
        id: `u${n}`,
        type: 'userMessage',
        clientId: null,
        content: [
          {
            type: 'text',
            text: n === 3 ? text(1_212_105) : `合成消息 ${n}\n${text(1000)}`,
            text_elements: [],
          },
        ],
      }),
    ]
    if (n % 70 === 0 && compactions < 18) {
      compactions++
      items.push(item({ id: `compact${n}`, type: 'contextCompaction' }))
    }
    // 把最长一段放在末尾，保证操作时要处理真实规模的活跃回合。
    const count = n === 1264 ? 102 : n < 621 ? 4 : 3
    for (let k = 0; k < count && tools < 4515; k++) {
      tools++
      items.push(
        item({
          id: `tool${tools}`,
          type: 'commandExecution',
          command: `node synthetic-task-${tools}.mjs`,
          cwd: '/synthetic',
          processId: null,
          pluginId: null,
          scriptPath: null,
          source: 'agent',
          status: n === 1264 && k === count - 1 ? 'inProgress' : 'completed',
          commandActions: [],
          aggregatedOutput: text(9300),
          exitCode: 0,
          durationMs: 50,
        }),
      )
      if (reasoning < (n === 1264 ? 2022 : 1972) && (k % 2 === 0 || n === 1264)) {
        reasoning++
        items.push(
          item({ id: `reason${reasoning}`, type: 'reasoning', summary: [text(4000)], content: [] }),
        )
      }
      if (events < 2025 && k < 2) {
        events++
        items.push(
          item({
            id: `event${events}`,
            type: 'userMessage',
            clientId: null,
            content: [{ type: 'text', text: eventText(events), text_elements: [] }],
          }),
        )
      }
    }
    if (n === 1264)
      while (events < 2139) {
        events++
        items.push(
          item({
            id: `event${events}`,
            type: 'userMessage',
            clientId: null,
            content: [{ type: 'text', text: eventText(events), text_elements: [] }],
          }),
        )
      }
    if (n < 367)
      items.push(
        item({
          id: `extra${n}`,
          type: 'agentMessage',
          text: text(1000),
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        }),
      )
    items.push(
      item({
        id: `a${n}`,
        type: 'agentMessage',
        text: text(7000),
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }),
    )
    turns.push({
      id: `t${n}`,
      status: n === 1264 ? 'inProgress' : 'completed',
      error: null,
      items,
      startedAt: n,
      completedAt: n + 1,
      durationMs: 1000,
    } as Turn)
  }
  const thread = { id: 'long-latency', cwd: '/synthetic', name: '合成大会话', turns } as Thread
  return {
    thread,
    counts: {
      turns: turns.length,
      items: turns.reduce((n, t) => n + t.items.length, 0),
      tools,
      reasoning,
      events,
      compactions,
      maxTurnItems: Math.max(...turns.map((t) => t.items.length)),
      bytes: new TextEncoder().encode(JSON.stringify(thread)).byteLength,
    },
  }
}

export function longCommandView() {
  const { thread, counts } = longCommandThread()
  const start = performance.now()
  const view = projectThread(thread, { deviceId: 'local', harness: 'claude' })
  view.live = true
  view.can.rollback = true
  // Claude 聚合面声明后台集合，不能误走旧端的逐条推导分支。
  view.can.backgroundTasks = true
  return { view, counts, projectionMs: performance.now() - start }
}
