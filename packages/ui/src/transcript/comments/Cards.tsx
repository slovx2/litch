// 发出去的评论在对话里的样子：用户消息开头那一段画成编号的评论卡片（引用淡一点、评论正常字），下面才是打的字。
// 点卡片跳到原文闪一下；原文不在这个会话里了就只把这张卡片的引用展开成全文。
import type { ParsedComment } from '@litch/core'
import { useT } from '../../app/appearance.ts'
import { useServices } from '../../app/services.tsx'
import { useToggle } from '../state.ts'
import { revealOrigin } from './locate.ts'

interface CardsProps {
  deviceId: string
  sessionId: string
  /** 这条用户消息 */
  itemId: string
  comments: ParsedComment[]
}

/** 一张卡片展开没有，记在对话区的展开状态里：[N] 找不到原文时也从这里替它展开 */
export const cardToggle = (itemId: string, index: number) => `c:${itemId}:${index}`

/** 找卡片用的标记 */
export const cardMark = (itemId: string, index: number) => `${itemId}:${index}`

export function SentComments({ deviceId, sessionId, itemId, comments }: CardsProps) {
  const t = useT()
  return (
    <ol className="ucmts" aria-label={t('comment.sent', { n: comments.length })}>
      {comments.map((comment) => (
        <SentCard
          key={comment.index}
          deviceId={deviceId}
          sessionId={sessionId}
          itemId={itemId}
          comment={comment}
        />
      ))}
    </ol>
  )
}

function SentCard({
  deviceId,
  sessionId,
  itemId,
  comment,
}: Omit<CardsProps, 'comments'> & { comment: ParsedComment }) {
  const t = useT()
  const { store } = useServices().replica
  const [full, setFull] = useToggle(
    `${deviceId}:${sessionId}`,
    cardToggle(itemId, comment.index),
    false,
  )
  const open = () => {
    void revealOrigin(store, { deviceId, sessionId, quote: comment.quote, before: itemId }).then(
      (found) => {
        if (!found) setFull(true)
      },
    )
  }
  return (
    <li className="ucmt" data-ucmt={cardMark(itemId, comment.index)}>
      <button
        type="button"
        className="ucmt-btn"
        title={t('comment.card.open')}
        aria-label={t('comment.card.label', { n: comment.index })}
        onClick={open}
      >
        <span className="ucmt-n">{comment.index}</span>
        <span className="ucmt-body">
          <span className={full ? 'ucmt-quote' : 'ucmt-quote fold'}>{comment.quote}</span>
          {comment.note ? <span className="ucmt-note">{comment.note}</span> : null}
        </span>
      </button>
    </li>
  )
}
