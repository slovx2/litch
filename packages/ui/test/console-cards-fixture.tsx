// 正式分页组件、模拟核心与隔离通道；不读取本机看板。
import '../src/styles/index.css'
import '../src/styles/manager.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { consoleCardsFixture } from '../../core/test/console-cards-fixture.mts'
import { onOpenSessionRequest } from '../src/app/actions.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { treeKey, treeUiNow } from '../src/files/state.ts'
import { BoardReferencesContext } from '../src/manager/BoardReferences.tsx'
import { ManagerFeaturesContext } from '../src/manager/data.ts'
import { setIssueOrder } from '../src/manager/issue-order.tsx'
import { PagedBoard } from '../src/manager/PagedBoard.tsx'
import { RelationsContext } from '../src/manager/Relations.tsx'

const fixture = consoleCardsFixture(createMockCore({ clock: browserClock, lang: 'zh-CN' }))
const {
  core: host,
  manager,
  board,
  view,
  state: { calls },
} = fixture
const [ui, core] = createPortPair()
serveChannel(core, host as typeof mock, { clock: browserClock })
const channel = connectChannel(ui)
const replica = createReplica(channel)
replica.start()
setIssueOrder('newest')
Object.assign(window, {
  __consoleCards: { calls, file: () => treeUiNow(treeKey('local', '/outside')), opened: [] },
})
Object.assign(window, {
  litchShell: { openExternal: (url: string) => window.__consoleCards.opened.push(url) },
})
onOpenSessionRequest((session) => window.__consoleCards.opened.push(session.sessionId))
// ?tab=decisions 打开决策页；?drafts=1 预置草稿、?drafts=conflict 再加一条待确认（见核心夹具）；?width=、?height= 改列表尺寸
const params = new URLSearchParams(location.search)
if (params.has('drafts'))
  localStorage.setItem(
    `litch.manager.answers:${JSON.stringify([manager.deviceId, manager.id])}`,
    JSON.stringify({
      ...fixture.drafts.answers,
      ...(params.get('drafts') === 'conflict' ? fixture.drafts.conflict : {}),
    }),
  )
/** ?settle=1：提交后像设备那样稍后推来新看板，交掉的决策离开待定 */
function Board() {
  const [current, setCurrent] = useState(view)
  const [tab, setTab] = useState(params.get('tab') ?? 'requests')
  const [other, setOther] = useState(false)
  const [mounted, setMounted] = useState(true)
  useEffect(() => {
    if (!params.has('settle')) return
    fixture.state.onSubmit = (ids) => setTimeout(() => setCurrent(fixture.settle(ids)), 50)
  }, [])
  return (
    <>
      {params.has('memory') ? (
        <nav style={{ position: 'fixed', top: 520 }}>
          <button type="button" data-memory-tab="decisions" onClick={() => setTab('decisions')}>
            决策
          </button>
          <button type="button" data-memory-tab="requests" onClick={() => setTab('requests')}>
            请求
          </button>
          <button type="button" data-memory-tab="overview" onClick={() => setTab('overview')}>
            概览
          </button>
          <button type="button" data-memory-manager onClick={() => setOther(!other)}>
            切经理
          </button>
          <button type="button" data-memory-mount onClick={() => setMounted(!mounted)}>
            离开或返回
          </button>
          <button
            type="button"
            data-memory-delay
            onClick={() => {
              setMounted(false)
              const missing = {
                ...view,
                board: { ...board, posts: [] },
                paging: { ...view.paging, pages: {} },
              }
              setCurrent(missing as typeof view)
              setTimeout(() => setMounted(true), 20)
              setTimeout(() => setCurrent({ ...view, board: { ...board, posts: [] } }), 100)
              setTimeout(() => setCurrent(view), 450)
            }}
          >
            延迟列表与详情
          </button>
          <button
            type="button"
            data-memory-remove
            onClick={() => setCurrent(fixture.settle(['D-2']))}
          >
            移除 D-2
          </button>
        </nav>
      ) : null}
      {mounted ? (
        <PagedBoard
          key={other ? 'other' : 'first'}
          manager={other ? { ...manager, id: 'other-manager' } : manager}
          view={current as any}
          tab={tab}
          disabled={false}
          target={null}
          onLocated={() => {}}
          onSuggestionSource={() => {}}
          overviewCounts={{
            decisions: { pending: 6, total: 6 },
            requests: { pending: 3, total: 3 },
            reports: { pending: 0, total: 0 },
            suggestions: { pending: 0, total: 0 },
          }}
          onInbox={setTab}
        />
      ) : null}
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <ManagerFeaturesContext.Provider value={view.features}>
      <RelationsContext.Provider value={{ manager, board }}>
        <BoardReferencesContext.Provider
          value={{
            ids: new Set(['D-15', 'I-2']),
            open: (id) => window.__consoleCards.opened.push(id),
          }}
        >
          <div
            className="mg-body"
            style={{
              height: Number(params.get('height') ?? 500),
              overflow: 'auto',
              width: Number(params.get('width') ?? 800),
            }}
          >
            <Board />
          </div>
        </BoardReferencesContext.Provider>
      </RelationsContext.Provider>
    </ManagerFeaturesContext.Provider>
  </ServicesProvider>,
)
