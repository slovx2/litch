// 正式控制台和抽屉，全部数据为虚构；不连接个人设备或会话。
import '../src/styles/index.css'
import '../src/styles/manager.css'
import '../src/styles/manager-issues.css'
import { type CoreChannel, createMockCore, createReplica } from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  managerIssueHead,
  managerIssueKindFilter,
  managerIssuePageKey,
  managerIssueQuery,
} from '../../core/src/projection/manager-issue-list.mts'
import { consoleCardsFixture } from '../../core/test/console-cards-fixture.mts'
import type { ManagerIssue } from '../../protocol/src/manager-issues.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { DiscussionPane } from '../src/manager/DiscussionPane.tsx'
import { ManagerFeaturesContext } from '../src/manager/data.ts'
import { DiscussionPaneContext } from '../src/manager/discussion-pane.ts'
import { IssueConsole } from '../src/manager/issues/IssueConsole.tsx'
import { RelationsContext } from '../src/manager/Relations.tsx'

const fixture = consoleCardsFixture(createMockCore({ clock: browserClock, lang: 'zh-CN' }))
const { manager, board } = fixture
const { paging: _paging, ...view } = fixture.view
const decision = board.decisions[0]!
decision.title = '星云索引更新策略'
decision.background =
  '背景：星云项目每天生成一次索引，需要决定如何提示更新进度。\n\n讨论重点是提示出现的位置和频率，避免影响阅读。'
decision.options = [
  { id: 'a', label: '索引完成后显示提示', description: '在项目列表中显示最近更新的日期。' },
  { id: 'b', label: '每周汇总一次', description: '将更新情况放进周报。' },
]
board.decisions = [decision]
const post = board.posts?.find((one) => one.id === decision.id)
if (post) {
  post.title = decision.title
  post.body = decision.background
}
const issue: ManagerIssue = {
  id: decision.id,
  kind: 'decision',
  title: decision.title,
  body: decision.background,
  status: 'open',
  stateGroup: 'open',
  author: { kind: 'manager' },
  revision: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  unread: false,
  followUp: { state: 'on', changedAt: Date.now(), changedBy: 'manager' },
  quick: { revision: decision.revision },
  relations: [],
  timeline: [],
  discussion: {
    opened: true,
    summary: null,
    questions: [],
    comments: [
      {
        id: 'nebula-c1',
        revision: 1,
        author: { kind: 'user' },
        body: '只在完成时提示，是否会错过正在进行的更新？',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        replyTo: null,
      },
      {
        id: 'nebula-c2',
        revision: 1,
        author: { kind: 'manager' },
        body: '可以在列表中保留轻量状态，完成后再显示日期。',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        replyTo: null,
      },
    ],
  },
}
const channel = {
  command: async () => ({}),
  subscribe: () => () => {},
  close() {},
} as unknown as CoreChannel
const replica = createReplica(channel)

function Fixture() {
  const [talk, setTalk] = useState<string | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [listed, setListed] = useState(true)
  Object.assign(window, {
    __issueDrawer: {
      hide: () => setListed(false),
      show: () => setListed(true),
      open: () => setTalk(`issue:${issue.id}`),
    },
  })
  const filter = managerIssueKindFilter('decision')
  const issues = {
    supported: true,
    discussions: true,
    loading: [],
    error: null,
    details: { [issue.id]: issue },
    pages: {
      [managerIssuePageKey(manager.id, filter)]: {
        query: managerIssueQuery(manager.id, filter),
        entries: listed ? [managerIssueHead(issue)] : [],
        total: listed ? 1 : 0,
        nextCursor: null,
      },
    },
  }
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <ManagerFeaturesContext.Provider value={fixture.view.features}>
        <RelationsContext.Provider value={{ manager, board }}>
          <DiscussionPaneContext.Provider
            value={{ host, openId: talk, open: setTalk, close: () => setTalk(null) }}
          >
            <main style={{ width: 1100, height: 860, margin: '16px auto' }} className="mg-board">
              <header className="mg-talk-head">
                <b>星云项目 · 经理控制台</b>
              </header>
              <div className="mg-body">
                <IssueConsole
                  manager={manager}
                  kind="decision"
                  view={view}
                  issues={issues}
                  disabled={false}
                  reason=""
                  target={null}
                  preset={null}
                  onKind={() => {}}
                  onLocated={() => {}}
                  onOpenItem={() => {}}
                  onSuggestionSource={() => {}}
                />
              </div>
              {talk ? (
                <DiscussionPane
                  id={issue.id}
                  title={issue.title}
                  issue
                  onHost={setHost}
                  onClose={() => setTalk(null)}
                  onBack={() => {}}
                />
              ) : null}
            </main>
          </DiscussionPaneContext.Provider>
        </RelationsContext.Provider>
      </ManagerFeaturesContext.Provider>
    </ServicesProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
