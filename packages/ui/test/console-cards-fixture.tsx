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
            <PagedBoard
              manager={manager}
              view={view as any}
              tab={params.get('tab') ?? 'requests'}
              disabled={false}
              target={null}
              onLocated={() => {}}
              onSuggestionSource={() => {}}
            />
          </div>
        </BoardReferencesContext.Provider>
      </RelationsContext.Provider>
    </ManagerFeaturesContext.Provider>
  </ServicesProvider>,
)
