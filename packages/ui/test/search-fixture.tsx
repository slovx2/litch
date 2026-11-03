import {
  type Clock,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type HostSink,
  projectThread,
  reduceSession,
  type SessionView,
  serveChannel,
} from '@litch/core'
import { flushSync } from 'react-dom'
// 仅由隔离浏览器验收访问；正式页面不引用此入口，不连接 harness 或个人数据。
import { createRoot } from 'react-dom/client'
import { askReplyText } from '../../core/src/projection/asks.mts'
import { bodyOf } from '../../core/src/projection/outgoing.mts'
import type { Thread } from '../../protocol/src/index.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { PendingQuestions } from '../src/composer/PendingQuestions.tsx'
import { requestSearch } from '../src/search/actions.ts'
import { FindButton } from '../src/search/FindButton.tsx'
import { TitleSearch } from '../src/search/TitleSearch.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'
import '../src/styles/index.css'

const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = window.setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const params = new URLSearchParams(location.search)
const sample = params.has('mock')
const sessionId = sample ? 's1' : 'search-fixture'
const mock = createMockCore({ clock, chunkMs: Number(params.get('chunkMs') ?? 60) })
const paged = params.has('paging')
const count = paged ? 100 : 5000
const turns = Array.from({ length: count }, (_, i) => ({
  id: `t${i}`,
  status: 'completed',
  items: [
    {
      id: `u${i}`,
      type: 'userMessage',
      content: [{ type: 'text', text: i === 0 ? '最早中文 👩‍💻 İSTANBUL' : '用户消息' }],
    },
    {
      id: `a${i}`,
      type: 'agentMessage',
      text:
        i === 0
          ? '跨**节点**匹配\n\n```ts\nconst CodeNeedle = "代码"\n```'
          : '普通回答 ' + '容量文本 '.repeat(100),
      phase: 'final_answer',
    },
  ],
}))
turns[0]!.items.splice(
  1,
  0,
  { id: 'thought', type: 'reasoning', summary: ['折叠思考 ThoughtNeedle'], content: [] } as never,
  {
    id: 'command',
    type: 'commandExecution',
    command: 'ToolNeedle',
    aggregatedOutput: 'ToolNeedle',
    status: 'completed',
    cwd: '/',
  } as never,
  { id: 'note', type: 'agentMessage', text: '收起的过程说明 ProcessNeedle', phase: 'commentary' },
  { id: 'plan', type: 'plan', text: '计划 **PlanNeedle**' } as never,
  {
    id: 'asked',
    type: 'dynamicToolCall',
    namespace: null,
    tool: 'AskUserQuestion',
    arguments: {},
    contentItems: [],
    success: true,
  } as never,
)
const view: SessionView = projectThread(
  {
    id: 'search-fixture',
    name: '搜索验收',
    cwd: '/',
    preview: '搜索验收',
    turns,
  } as unknown as Thread,
  { deviceId: 'local', harness: 'claude' },
)
view.live = false
view.items['t0:asked'] = {
  id: 't0:asked',
  kind: 'toolCall',
  tool: 'AskUserQuestion',
  source: null,
  input: [],
  output: [],
  error: null,
  durationMs: null,
  status: 'completed',
  asked: {
    questions: [
      {
        header: '选择',
        question: 'QuestionNeedle',
        options: [{ label: 'OptionNeedle', description: '说明' }],
        answer: 'AnswerNeedle',
        picked: [],
        other: null,
      },
    ],
    raw: null,
  },
}
const comment = bodyOf(
  {
    text: '评论正文',
    extras: [{ kind: 'comment', itemId: 't0:a0', quote: 'QuoteNeedle', note: 'CommentNeedle' }],
  },
  true,
)
view.items['t1:u1'] = { id: 't1:u1', kind: 'userMessage', text: comment, attachments: [] }
let sink: HostSink | null = null
let refreshFails = false
const allHistory = paged ? structuredClone(view) : view
let pageCalls = 0
if (paged) {
  view.turns = view.turns.slice(-10)
  const wanted = new Set(view.turns.flatMap((turn) => turn.itemIds))
  view.items = Object.fromEntries(Object.entries(view.items).filter(([id]) => wanted.has(id)))
  view.history = { hasMore: true, loading: false, error: null }
}
const host: CoreHost = {
  async command(name, args, signal) {
    if (name === 'session.loadOlder' && paged) {
      if (!view.history?.hasMore || view.history.loading) return {} as never
      pageCalls++
      view.history = { hasMore: true, loading: true, error: null }
      sink?.delta([{ op: 'session.history', history: view.history }])
      await new Promise((resolve) => setTimeout(resolve, 80))
      const end = allHistory.turns.findIndex((turn) => turn.id === view.turns[0]?.id)
      const older = allHistory.turns.slice(Math.max(0, end - 10), end)
      const op = {
        op: 'history.prepend' as const,
        turns: older,
        items: older.flatMap((turn) => turn.itemIds.map((id) => allHistory.items[id]!)),
      }
      reduceSession(view, op)
      view.history = { hasMore: end > 10, loading: false, error: null }
      sink?.delta([op, { op: 'session.history', history: view.history }])
      return {} as never
    }
    if (name === 'device.refresh') {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (refreshFails) throw new Error('隔离夹具：读取失败')
      return {} as never
    }
    return mock.command(name, args, signal)
  },
  subscribe(topic, receiver) {
    if (topic.kind === 'session' && topic.sessionId === 'search-fixture') {
      sink = receiver
      receiver.snapshot(view)
      return () => {
        sink = null
      }
    }
    return mock.subscribe(topic, receiver)
  },
}
const [client, server] = createPortPair()
serveChannel(server, host, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
const fixture = {
  // wind 的问答顺序，用完整对话组件验证显示、跳回原题与重读。
  answerReplyScene(mode: 'adjacent' | 'peer-first' | 'reply-first' | 'previous-turn') {
    const questionId =
      mode === 'previous-turn' ? '["wrap_up","q"]' : '["request_user_input_async","q",0]'
    const q =
      mode === 'previous-turn'
        ? {
            id: 'q',
            kind: 'toolCall' as const,
            tool: 'wrap_up',
            source: null,
            input: [],
            output: [],
            error: null,
            durationMs: null,
            status: 'completed' as const,
            wrapUp: { suggestions: [], ask: '下一步做什么？' },
          }
        : {
            id: 'q',
            kind: 'agentMessage' as const,
            text: '',
            status: 'completed' as const,
            phase: 'commentary' as const,
            questions: [{ id: questionId, title: '下一步做什么？', options: [] }],
          }
    const reply = {
      id: 'reply',
      kind: 'userMessage' as const,
      attachments: [],
      text: askReplyText([
        { questionItemId: questionId, question: '下一步做什么？', answer: 'AnswerPositionNeedle' },
      ]),
    }
    const peer = {
      id: 'peer',
      kind: 'userMessage' as const,
      attachments: [],
      text: '补齐证据',
      peer: { name: '基建', session: 'other', bypass: false },
    }
    const process = {
      id: 'work',
      kind: 'reasoning' as const,
      text: '继续处理',
      status: 'completed' as const,
    }
    const continued = {
      id: 'continued',
      kind: 'agentMessage' as const,
      text: '已记下决定',
      status: 'inProgress' as const,
      phase: 'commentary' as const,
    }
    const ids =
      mode === 'adjacent'
        ? ['q', 'reply', 'continued']
        : mode === 'peer-first'
          ? ['q', 'peer', 'reply', 'continued']
          : mode === 'reply-first'
            ? ['q', 'work', 'reply', 'peer', 'continued']
            : ['peer', 'reply', 'continued']
    const turn = (id: string, itemIds: string[], status: 'running' | 'completed') => ({
      id,
      itemIds,
      status,
      startedAt: null,
      durationMs: null,
      error: null,
    })
    view.turns = [
      ...(mode === 'previous-turn' ? [turn('old', ['q'], 'completed')] : []),
      turn('live', ids, 'running'),
    ]
    view.items = Object.fromEntries(
      [q, reply, peer, process, continued].map((item) => [item.id, item]),
    )
    sink?.snapshot(structuredClone(view))
  },
  rereadAnswerReply() {
    sink?.snapshot(structuredClone(view))
  },
  historyState: () => ({ pageCalls, turns: view.turns.length, history: view.history }),
  async reopen() {
    flushSync(() => root.render(null))
    await new Promise((resolve) => setTimeout(resolve, 30))
    view.turns = allHistory.turns.slice(-10)
    const wanted = new Set(view.turns.flatMap((turn) => turn.itemIds))
    view.items = Object.fromEntries(
      Object.entries(allHistory.items).filter(([id]) => wanted.has(id)),
    )
    view.history = { hasMore: true, loading: false, error: null }
    show()
  },
  openTitles: requestSearch,
  failRefresh(value: boolean) {
    refreshFails = value
  },
  opened: null as { deviceId: string; sessionId: string } | null,
  pulse() {
    let count = 0
    const timer = window.setInterval(() => {
      const id = 't4999:a4999'
      const item = view.items[id]
      if (item?.kind !== 'agentMessage') return
      const text = count++ === 0 ? ' PulseNeedle' : ' 增量'
      view.items[id] = { ...item, text: item.text + text }
      sink?.delta([{ op: 'item.appendText', itemId: id, field: 'text', text }])
      if (count === 100) clearInterval(timer)
    }, 30)
  },
  ask() {
    const id = 't4999:a4999',
      item = view.items[id]
    if (item?.kind !== 'agentMessage') return
    view.items[id] = {
      ...item,
      questions: [{ id: 'async-test', title: 'PendingNeedle', options: ['PendingOptionNeedle'] }],
    }
    sink?.snapshot(view)
  },
  answer() {
    const id = 't4999:reply'
    view.items[id] = {
      id,
      kind: 'userMessage',
      attachments: [],
      text: askReplyText([
        {
          questionItemId: 'async-test',
          question: 'PendingNeedle',
          answer: 'AnsweredAsyncNeedle',
        },
      ]),
    }
    view.turns.at(-1)?.itemIds.push(id)
    sink?.snapshot(view)
  },
  append(text: string) {
    const originalId = `t${count - 1}:a${count - 1}`
    const original = view.items[originalId]
    const id =
      original?.kind === 'agentMessage' && original.questions?.length
        ? 't4999:continuation'
        : originalId
    const item = view.items[id]
    if (!item) {
      const added = {
        id,
        kind: 'agentMessage' as const,
        text,
        phase: 'final' as const,
        status: 'completed' as const,
      }
      view.items[id] = added
      view.turns.at(-1)?.itemIds.push(id)
      sink?.delta([{ op: 'item.add', turnId: 't4999', item: added }])
    } else if (item.kind === 'agentMessage') {
      view.items[id] = { ...item, text: item.text + text }
      sink?.delta([{ op: 'item.appendText', itemId: id, field: 'text', text }])
    }
  },
  replaceFirst(text: string) {
    const id = 't0:a0'
    view.items[id] = { ...view.items[id]!, text } as never
    sink?.snapshot(view)
  },
}
Object.assign(window, { searchFixture: fixture })
const root = createRoot(document.getElementById('root')!)
const show = () =>
  root.render(
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <div style={{ height: '100vh', display: 'flex' }}>
        <main className="main">
          <FindButton deviceId="local" sessionId={sessionId} />
          <Transcript
            deviceId="local"
            sessionId={sessionId}
            footer={
              <>
                <PendingQuestions deviceId="local" sessionId={sessionId} />
                <span>隔离验收</span>
              </>
            }
          />
          <TitleSearch
            onOpen={(selection) => {
              fixture.opened = selection
            }}
          />
        </main>
      </div>
    </ServicesProvider>,
  )
show()
