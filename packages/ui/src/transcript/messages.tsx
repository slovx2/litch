// 对话区里直接露在外面的三种块：用户消息、助手回答、计划。
// 每个组件只订阅自己那一个条目：流式文本到达时只有正在变的那一条重画。
import {
  type AgentMessageItem,
  type ItemView,
  keys,
  type PlanItem,
  parseAskReply,
  type UserAttachment,
  type UserMessageItem,
} from '@litch/core'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { ImageViewer } from '../app/ImageViewer.tsx'
import { useKey } from '../app/services.tsx'
import { SessionEventBar } from '../tree/EventBar.tsx'
import { AskReplyBody } from './AskCard.tsx'
import { SentComments } from './comments/Cards.tsx'
import { commentsOf } from './comments/Cite.tsx'
import { Markdown } from './Markdown.tsx'
import { usePin } from './scroll.ts'
import { useSmoothText, useToggle } from './state.ts'
import { TurnActions } from './TurnActions.tsx'

export interface ItemRef {
  deviceId: string
  sessionId: string
  itemId: string
}

export const useItem = <T extends ItemView>({ deviceId, sessionId, itemId }: ItemRef) =>
  useKey<T>(keys.item(deviceId, sessionId, itemId))

export const sessionKeyOf = (ref: { deviceId: string; sessionId: string }) =>
  `${ref.deviceId}:${ref.sessionId}`

/**
 * 用户消息带的东西。能直接显示的图片是固定大小的缩略图（图片解出来之前之后占的地方一样，
 * 对话不会因为它跳一下），点开看大图；别的只显示名字。
 */
export function UserAttachments({ attachments }: { attachments: UserAttachment[] }) {
  const t = useT()
  const [viewing, setViewing] = useState<UserAttachment | null>(null)
  if (attachments.length === 0) return null
  return (
    <div className="atts">
      {attachments.map((attachment, index) =>
        attachment.url ? (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: 附件发出去之后不会增删换位
            key={index}
            type="button"
            className="uimg"
            title={attachment.label ?? t('attachment.view')}
            aria-label={t('attachment.view')}
            onClick={() => setViewing(attachment)}
          >
            <img src={attachment.url} alt={attachment.label ?? t('attachment.image')} />
          </button>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 附件发出去之后不会增删换位
          <span key={index} className="mention" title={t(`attachment.${attachment.kind}`)}>
            {attachment.label ?? t(`attachment.${attachment.kind}`)}
          </span>
        ),
      )}
      {viewing?.url ? (
        <ImageViewer
          url={viewing.url}
          label={viewing.label ?? t('attachment.image')}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  )
}

interface UserMessageProps extends ItemRef {
  /** 给了就在这条消息上出“分叉”“回退”：它是这个回合开头的那条，而且现在做得了 */
  turnId?: string | undefined
}

/**
 * 用户消息：靠右的气泡。很长的时候先收成 20 行，可以展开。
 * 设备进程注入的回报、唤醒（item.event）画成气泡上面的一条系统提示；唤醒的回合没有用户自己的话，只有那一条
 */
export const UserMessage = memo(function UserMessage({ turnId, ...ref }: UserMessageProps) {
  const item = useItem<UserMessageItem>(ref)
  const [open, setOpen] = useToggle(sessionKeyOf(ref), `u:${ref.itemId}`, false)
  const [long, setLong] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  const bubble = useRef<HTMLDivElement | null>(null)
  const pin = usePin()
  const t = useT()
  const said = item?.kind === 'userMessage' ? item.text : ''
  // 答模型边干活边问的题时发的那一段：画成题目和回答
  const replies = parseAskReply(said)
  // 开头带着评论的：评论画成卡片，下面只出打的字
  const comments = replies ? null : commentsOf(said)
  const text = comments ? comments.rest : said

  // 是不是超过了 20 行，要画出来才知道，而且跟宽度有关：盯着这块文字的尺寸，变了就重新量
  const hasText = text !== ''
  useLayoutEffect(() => {
    const element = body.current
    if (!element || open || !hasText) return
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasText, open])

  if (item?.kind !== 'userMessage') return null
  const event = item.event
  if (event && !said && item.attachments.length === 0) {
    return <SessionEventBar deviceId={ref.deviceId} event={event} anchor={`u:${ref.itemId}`} />
  }
  const message = (
    <div className="umsg" data-anchor={`u:${ref.itemId}`} ref={bubble}>
      <UserAttachments attachments={item.attachments} />
      {comments ? <SentComments {...ref} comments={comments.comments} /> : null}
      {replies ? (
        <AskReplyBody replies={replies} />
      ) : text ? (
        <div className={open ? 'umsg-text' : 'umsg-text clamp'} ref={body}>
          {text}
        </div>
      ) : null}
      {long || open ? (
        <button
          type="button"
          className="mini"
          onClick={() => {
            pin(bubble.current)
            setOpen(!open)
          }}
        >
          {t(open ? 'message.collapse' : 'message.expand')}
        </button>
      ) : null}
      {turnId ? <TurnActions {...ref} turnId={turnId} /> : null}
    </div>
  )
  if (!event) return message
  return (
    <>
      <SessionEventBar deviceId={ref.deviceId} event={event} />
      {message}
    </>
  )
})

/** 助手回答。还在往外出字时文字匀速放出，结尾带一个光标 */
export const AgentAnswer = memo(function AgentAnswer(ref: ItemRef) {
  const item = useItem<AgentMessageItem>(ref)
  const { text, revealing } = useSmoothText(item?.kind === 'agentMessage' ? item.text : '')
  if (item?.kind !== 'agentMessage') return null
  // 条目已经定稿但字还没放完时，继续按“输出中”画，放完那一刻才换成定稿的样子，中间没有跳变
  const streaming = item.status === 'inProgress' || revealing
  return <Markdown text={text} streaming={streaming} anchor={`a:${ref.itemId}`} item={ref.itemId} />
})

/** 计划：一张卡片，内容按 Markdown 画 */
export const PlanCard = memo(function PlanCard(ref: ItemRef) {
  const item = useItem<PlanItem>(ref)
  const t = useT()
  if (item?.kind !== 'plan') return null
  return (
    // 标记打在里面的每一块上，卡片自己不带：带标记的行不能互相套着
    <div className="plan">
      <div className="plan-head">{t('plan.title')}</div>
      <div className="plan-body">
        <Markdown text={item.text} streaming={false} anchor={`p:${ref.itemId}`} />
      </div>
    </div>
  )
})
