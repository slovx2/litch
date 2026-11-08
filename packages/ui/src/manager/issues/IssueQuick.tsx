// 特殊 issue 的快速处理区：决策选答案、请你做交付、建议开始、报告已阅，原样复用原来的卡片（内嵌，不再画第二个卡头）。
// 走旧看板命令时用历史编号（D-n/R-n/P-n/S-…）；分页看板先读一次详情。
import { managerBoardPages } from '@litch/core'
import { useEffect } from 'react'
import type {
  ManagerBoardView,
  ManagerObjectId,
  ManagerView,
} from '../../../../core/src/model-manager.mts'
import type { ManagerDraftBoard } from '../../../../core/src/projection/manager-drafts.mts'
import type { Selection } from '../../app/App.tsx'
import { useT } from '../../app/appearance.ts'
import { useServices } from '../../app/services.tsx'
import { ManagerSuggestions } from '../../tree/SuggestionsPage.tsx'
import { Decisions } from '../Decisions.tsx'
import { InlinePostContext } from '../PostCard.tsx'
import { Reports } from '../Reports.tsx'
import { Requests } from '../Requests.tsx'

export function IssueQuick({
  manager,
  board,
  legacyId,
  paged,
  disabled,
  draftBoard,
  onSuggestionSource,
}: {
  manager: ManagerView
  board: ManagerBoardView
  legacyId: string
  paged: boolean
  disabled: boolean
  draftBoard: ManagerDraftBoard
  onSuggestionSource(selection: Selection, archived: boolean): void
}) {
  const t = useT()
  const { channel } = useServices()
  const { deviceId, id: managerId } = manager
  useEffect(() => {
    if (!paged) return
    void channel
      .command('managers.board.detail', {
        deviceId,
        managerId,
        id: legacyId as ManagerObjectId,
      })
      .catch(() => {})
  }, [paged, channel, deviceId, managerId, legacyId])
  const post = board.posts?.find((one) => one.id === legacyId)
  const decision = board.decisions.some((one) => one.id === legacyId)
  if (!post && !decision) return <p className="dim">{t('manager.loading')}</p>
  return (
    <InlinePostContext.Provider value={true}>
      <section
        className="mg-issue-quick"
        data-paging-detail={legacyId}
        aria-label={t('issue.quick')}
      >
        {post?.kind === 'report' ? (
          <Reports manager={manager} posts={[post]} disabled={disabled} />
        ) : null}
        {post?.kind === 'request' ? (
          <Requests
            manager={manager}
            posts={[post]}
            requests={(board.requests ?? []).filter((one) => one.id === legacyId)}
            disabled={disabled}
            target={null}
            onLocated={() => {}}
          />
        ) : null}
        {post?.kind === 'suggestion' ? (
          <ManagerSuggestions
            onlyId={post.id}
            posts={[post]}
            manager={manager}
            onOpen={onSuggestionSource}
          />
        ) : null}
        {decision ? (
          <Decisions
            manager={manager}
            posts={board.posts ?? []}
            decisions={board.decisions}
            changes={board.changes}
            requests={board.requests ?? []}
            groups={managerBoardPages(board).decisions}
            onlyId={legacyId}
            visible
            disabled={disabled}
            target={null}
            onLocated={() => {}}
            onBusy={() => {}}
            part="cards"
            draftBoard={draftBoard}
          />
        ) : null}
      </section>
    </InlinePostContext.Provider>
  )
}
