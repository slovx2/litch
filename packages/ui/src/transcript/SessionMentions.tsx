// 用户消息里提到的会话（核心认出来的 UserMessageItem.sessions）：正文里的 ＠[标题] 画成能点的片，点了打开那个会话。
// 回答里也认：紧跟在这条用户消息后面、同一回合里助手写的 @[标题] 或 ＠[标题]，标题对得上的同样画成片
// （CiteScope 顺带把这条消息提到的会话交下来）。会话已经不在侧栏里（删了、设备没连着）的片灰掉，点不了。
import {
  type DeviceView,
  keys,
  mentionSegments,
  type ParsedSessionMention,
  SENT_SIGIL,
  type SessionMentionView,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { createContext, Fragment, type ReactNode, useContext, useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { useActions } from './actions.tsx'

interface MentionValue {
  deviceId: string
  sessions: readonly SessionMentionView[]
}

const MentionContext = createContext<MentionValue | null>(null)

/** 回答里一段字有没有可能带提及：先粗看一眼，绝大多数文字不用往下拆 */
export const HAS_MENTION = /[@＠]\[/

/** 给一回合里跟在用户消息后面的那些块：那条消息提到的会话 */
export function MentionScope({
  deviceId,
  sessions,
  children,
}: {
  deviceId: string
  sessions: readonly SessionMentionView[] | undefined
  children: ReactNode
}) {
  const value = useMemo(
    () => (sessions && sessions.length > 0 ? { deviceId, sessions } : null),
    [deviceId, sessions],
  )
  return <MentionContext.Provider value={value}>{children}</MentionContext.Provider>
}

/** 一个提到的会话：图标加标题。悬停写现在的标题（改过名的看得出来）、harness、工作区 */
export function SessionPill({
  deviceId,
  mention,
}: {
  deviceId: string
  mention: Pick<ParsedSessionMention, 'threadId' | 'title'>
}) {
  const t = useT()
  const { open } = useActions()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, mention.threadId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const body = (
    <>
      <Icon name="note" small />
      <span>{mention.title}</span>
    </>
  )
  if (!summary || !open) {
    return (
      <span className="smen gone" data-mention={mention.threadId} title={t('mention.gone')}>
        {body}
      </span>
    )
  }
  const workspace = workspaces?.find((one) => one.id === summary.workspaceId)?.name
  const about = [t.text(summary.title), nameOf(device, summary.harness), workspace]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      className="smen"
      data-mention={mention.threadId}
      title={t('mention.open', { about })}
      onClick={() => open({ deviceId, sessionId: mention.threadId })}
    >
      {body}
    </button>
  )
}

/** 用户消息的正文：提到的会话画成片，别的照原文 */
export function MentionedText({
  deviceId,
  text,
  sessions,
}: {
  deviceId: string
  text: string
  sessions: readonly SessionMentionView[] | undefined
}) {
  if (!sessions || sessions.length === 0) return <>{text}</>
  return (
    <>
      {mentionSegments(text, sessions).map((segment, index) =>
        segment.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 一条消息发出去之后不会变
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上
          <SessionPill key={index} deviceId={deviceId} mention={segment.mention} />
        ),
      )}
    </>
  )
}

/**
 * 回答里的一段字：对得上这一回合用户提到的会话的 @[标题]（模型也可能照抄成 ＠[标题]）画成片，
 * 别的部分交给 plain 照常画。不在提到会话的回合里、或者一个都对不上，整段交给 plain
 */
export function AnswerMentions({
  text,
  plain,
}: {
  text: string
  plain: (part: string, key: number) => ReactNode
}) {
  const scope = useContext(MentionContext)
  if (!scope) return plain(text, 0)
  // 模型写的 @[标题] 先换成 ＠[标题]，好和用户消息里的用同一套切法
  const same = text.replace(/@\[/g, `${SENT_SIGIL}[`)
  const segments = mentionSegments(same, scope.sessions)
  if (!segments.some((segment) => segment.kind === 'mention')) return plain(text, 0)
  let at = 0
  return (
    <>
      {segments.map((segment, index) => {
        // 换过的只是一个字，长度不变：按位置从原文里取，模型原样写的字照原样出
        const original = text.slice(at, at + segment.text.length)
        at += segment.text.length
        return segment.kind === 'text' ? (
          plain(original, index)
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 回答的一段字切出来的，顺序固定
          <SessionPill key={index} deviceId={scope.deviceId} mention={segment.mention} />
        )
      })}
    </>
  )
}
