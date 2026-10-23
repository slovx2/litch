// 用户消息里提到的会话（核心认出来的 UserMessageItem.sessions）：正文里的 ＠[标题] 画成强调色的字，点了打开那个会话。
// 套在气泡的那段文字里面（嵌套的 Text），长按气泡照旧出回合菜单。会话已经不在列表里（删了、设备没连着）的写成灰的，点不了。
import { keys, mentionSegments, type SessionMentionView, type SessionSummary } from '@litch/core'
import { Fragment } from 'react'
import { Text } from 'react-native'
import { useKey } from '../shell/services'
import { useTheme } from '../ui/theme'
import { useTranscript } from './context'

function Pill({ mention }: { mention: SessionMentionView }) {
  const { c } = useTheme()
  const { deviceId, openSession } = useTranscript()
  const listed = useKey<SessionSummary>(keys.summary(deviceId, mention.threadId))
  return (
    <Text
      testID={`mention-${mention.threadId}`}
      accessibilityRole={listed ? 'link' : undefined}
      onPress={listed ? () => openSession(mention.threadId) : undefined}
      style={{ color: listed ? c.accent : c.ink3, fontWeight: '600' }}
    >
      {`＠${mention.title}`}
    </Text>
  )
}

/** 一条用户消息的正文：提到的会话画成能点的字，别的照原文 */
export function MentionedText({
  text,
  sessions,
}: {
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
          <Pill key={index} mention={segment.mention} />
        ),
      )}
    </>
  )
}
