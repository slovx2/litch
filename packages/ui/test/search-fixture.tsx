import {
  type Clock,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type HostSink,
  projectThread,
  type SessionView,
  serveChannel,
} from '@litch/core'
// 仅由隔离浏览器验收访问；正式页面不引用此入口，不连接 harness 或个人数据。
import { createRoot } from 'react-dom/client'
import { askReplyText } from '../../core/src/projection/asks.mts'
import { bodyOf } from '../../core/src/projection/outgoing.mts'
import type { Thread } from '../../protocol/src/index.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { PendingQuestions } from '../src/composer/PendingQuestions.tsx'
import { requestSearch } from '../src/search/actions.ts'
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
const mock = createMockCore({ clock })
const count = 5000
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
const host: CoreHost = {
  command: mock.command.bind(mock),
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
Object.assign(window, {
  searchFixture: {
    openTitles: requestSearch,
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
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div style={{ height: '100vh', display: 'flex' }}>
      <main className="main">
        <Transcript
          deviceId="local"
          sessionId="search-fixture"
          footer={
            <>
              <PendingQuestions deviceId="local" sessionId="search-fixture" />
              <span>隔离验收</span>
            </>
          }
        />
        <TitleSearch onOpen={() => {}} />
      </main>
    </div>
  </ServicesProvider>,
)
