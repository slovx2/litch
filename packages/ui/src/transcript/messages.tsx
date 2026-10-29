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
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { SessionEventBar } from '../tree/EventBar.tsx'
import { AskReplyBody } from './AskCard.tsx'
import { questionItemOf } from './ask-ids.ts'
import { CompactRow } from './CompactRow.tsx'
import { SentComments } from './comments/Cards.tsx'
import { commentsOf } from './comments/Cite.tsx'
import { Markdown } from './Markdown.tsx'
import { MessageEdit } from './MessageEdit.tsx'
import { PeerHead } from './PeerHead.tsx'
import { MentionedText } from './SessionMentions.tsx'
import { SystemCard } from './SystemCard.tsx'
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
  /** 给了就在这条消息上出“分叉”“编辑”：现在做得了（回合结束了、设备连着这些） */
  turnId?: string | undefined
  /** 它不是回合开头的那条，是回合进行中插进来的话 */
  steered?: boolean
}

/**
 * 用户消息：靠右的气泡。很长的时候先收成 20 行，可以展开。
 * 设备进程注入的回报、唤醒（item.event）画成气泡上面的一条系统提示；唤醒的回合没有用户自己的话，只有那一条。
 * 别的会话发来的（item.peer）换一种底色，最上面一行写是谁发来的；正文是对方的原话，不认评论、答题这些格式，先收成几行。
 * Litch 替用户发的话（item.system：定时任务、子会话的简报、在这里做）画成系统卡片（SystemCard.tsx）
 */
export const UserMessage = memo(function UserMessage({
  turnId,
  steered = false,
  ...ref
}: UserMessageProps) {
  const item = useItem<UserMessageItem>(ref)
  const [open, setOpen] = useToggle(sessionKeyOf(ref), `u:${ref.itemId}`, false)
  const [long, setLong] = useState(false)
  /** 在原消息上编辑（MessageEdit.tsx）：气泡换成编辑框 */
  const [editing, setEditing] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  const bubble = useRef<HTMLDivElement | null>(null)
  const pin = usePin()
  const t = useT()
  const said = item?.kind === 'userMessage' ? item.text : ''
  const peer = item?.kind === 'userMessage' ? item.peer : undefined
  // 答模型边干活边问的题时发的那一段：答案并进问题卡（AskCard.tsx 的 AskSheet），这里不再画；
  // 问题那一条不在会话里（历史被截掉了）的才画成题目和回答
  const replies = peer ? null : parseAskReply(said)
  const { replica } = useServices()
  const folded =
    replies?.every((reply) => {
      const itemId = questionItemOf(reply.questionItemId)
      return (
        itemId !== null &&
        replica.store.get(keys.item(ref.deviceId, ref.sessionId, itemId)) !== undefined
      )
    }) === true
  // 开头带着评论的：评论画成卡片，下面只出打的字
  const comments = replies || peer ? null : commentsOf(said)
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
  if (editing && turnId)
    return (
      <MessageEdit {...ref} turnId={turnId} steered={steered} onDone={() => setEditing(false)} />
    )
  const event = item.event
  if (folded && item.attachments.length === 0)
    return event ? (
      <SessionEventBar
        sessionId={ref.sessionId}
        itemId={ref.itemId}
        deviceId={ref.deviceId}
        event={event}
        anchor={`u:${ref.itemId}`}
      />
    ) : null
  if (event && !said && item.attachments.length === 0) {
    return (
      <SessionEventBar
        sessionId={ref.sessionId}
        itemId={ref.itemId}
        deviceId={ref.deviceId}
        event={event}
        anchor={`u:${ref.itemId}`}
      />
    )
  }
  if (peer)
    return (
      <div className="sev sysm" data-peer="" data-anchor={`u:${ref.itemId}`} ref={bubble}>
        <CompactRow
          icon={<Icon name="note" small />}
          source={peer.name ? t('peer.from', { name: peer.name }) : t('peer.fromUnnamed')}
          summary={text}
          open={open}
          onToggle={() => {
            pin(bubble.current)
            setOpen(!open)
          }}
        />
        {open ? (
          <>
            <PeerHead deviceId={ref.deviceId} peer={peer} detail />
            <UserAttachments attachments={item.attachments} />
            <div className="sysm-full">{text}</div>
          </>
        ) : null}
      </div>
    )
  const message = item.system ? (
    <SystemCard {...ref} item={item} system={item.system} />
  ) : (
    <div
      className={peer ? 'umsg peer' : 'umsg'}
      data-anchor={`u:${ref.itemId}`}
      data-peer={peer ? '' : undefined}
      ref={bubble}
    >
      {peer ? <PeerHead deviceId={ref.deviceId} peer={peer} /> : null}
      <UserAttachments attachments={item.attachments} />
      {comments ? <SentComments {...ref} comments={comments.comments} /> : null}
      {replies ? (
        <AskReplyBody replies={replies} />
      ) : text ? (
        <div className={open ? 'umsg-text' : 'umsg-text clamp'} ref={body}>
          {peer ? (
            text
          ) : (
            <MentionedText deviceId={ref.deviceId} text={text} sessions={item.sessions} />
          )}
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
      {/* 别的会话发来的话不是自己插的，不在它上面切 */}
      {turnId && !(steered && peer) ? (
        <TurnActions {...ref} turnId={turnId} steered={steered} onEdit={() => setEditing(true)} />
      ) : null}
    </div>
  )
  if (!event) return message
  return (
    <>
      <SessionEventBar
        sessionId={ref.sessionId}
        itemId={ref.itemId}
        deviceId={ref.deviceId}
        event={event}
      />
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
