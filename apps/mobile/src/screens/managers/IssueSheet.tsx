// 对话里点 #D-n 拉起的半屏议题卡（35-manager 17.6）：里面就是控制台那张卡（Issue 组件），可以就地作答、忽略、交付；
// 讨论（❝）不在这里开第二层抽屉，等同“在控制台打开”并打开那条讨论。原来待处理、提交后不再待处理时自动关上，回到对话原处。
import type {
  ManagerBoardView,
  ManagerFeaturesView,
  ManagerView,
  SuggestionView,
} from '@litch/core'
import { useEffect, useRef } from 'react'
import { shortObjectId } from '../../../../../packages/ui/src/tree/proposal-brief.ts'
import { useT } from '../../ui/i18n'
import { DiscussionDrawer } from './DiscussionDrawer'
import { Issue } from './Issue'
import { IssueContext } from './IssueRelations'
import { issuePending } from './presentation'

export function IssueSheet({
  manager,
  board,
  features,
  suggestions,
  id,
  onClose,
  onConsole,
}: {
  manager: ManagerView
  board: ManagerBoardView
  features: ManagerFeaturesView
  suggestions: readonly SuggestionView[]
  /** 打开的议题编号；null 是关着 */
  id: string | null
  onClose(): void
  /** 在控制台打开（talk：顺手打开它的讨论） */
  onConsole(id: string, talk?: boolean): void
}) {
  const t = useT()
  const post = id ? board.posts?.find((p) => p.id === id) : undefined
  const pending = post ? issuePending(post, board, suggestions) : false
  // 打开时还待处理、之后不再待处理（答了、交付了、开始了）：关上
  const was = useRef<{ id: string | null; pending: boolean }>({ id: null, pending: false })
  useEffect(() => {
    if (was.current.id === id && was.current.pending && !pending) onClose()
    was.current = { id, pending }
  }, [id, pending, onClose])
  if (!post || !id) return null
  return (
    <DiscussionDrawer
      visible
      id={shortObjectId(post.id)}
      title={post.title}
      testID={`issue-sheet:${post.id}`}
      backLabel={t('mgr.sheet.console')}
      open={{ label: t('mgr.sheet.console'), onPress: () => onConsole(post.id) }}
      stickToEnd={false}
      onClose={onClose}
      onBack={() => onConsole(post.id)}
    >
      <IssueContext.Provider value={{ manager, board, features, open: (next) => onConsole(next) }}>
        <Issue
          manager={manager}
          post={post}
          board={board}
          suggestions={suggestions}
          talking={false}
          onTalk={(talk) => {
            if (talk) onConsole(post.id, true)
          }}
          onBack={() => {}}
          onPosition={() => {}}
          bare
        />
      </IssueContext.Provider>
    </DiscussionDrawer>
  )
}
