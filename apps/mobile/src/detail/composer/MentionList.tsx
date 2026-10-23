// 输入框里打 `@`：在输入框上面列这台设备上的会话（最近的几个，打了字按字挑），点一个写成 @[标题]，另外记下是哪个会话。
// 挑和排用桌面的同一份（packages/ui/src/composer/session-hits.ts）；手机还没有 @ 文件，这里只有会话。
// 归档的、当前会话、已经提到的不列；别的应用派出来的会话（列表里默认藏着的）也不列。
import {
  type DeviceView,
  keys,
  mentionTitle,
  SESSION_MENTION_LIMITS,
  type SessionGroups,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { nameOf } from '../../../../../packages/ui/src/app/device.ts'
import {
  insertMention,
  type SessionCandidate,
  sessionHits,
} from '../../../../../packages/ui/src/composer/session-hits.ts'
import { findTrigger, type Trigger } from '../../../../../packages/ui/src/composer/suggest.ts'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { SessionExtra } from './drafts'

const NONE = 'none'
const NO_IDS: string[] = []

/** 光标前面是不是正在打一个 `@` 开头的词 */
export function mentionTrigger(text: string, caret: number | null): Trigger | null {
  const at = Math.min(caret ?? text.length, text.length)
  const found = findTrigger(text, at)
  return found?.kind === 'at' ? found : null
}

export function MentionList({
  deviceId,
  sessionId,
  text,
  trigger,
  bound,
  onPick,
  testID,
}: {
  deviceId: string
  /** 当前会话；新建会话页上没有 */
  sessionId: string | null
  text: string
  trigger: Trigger
  /** 这条消息里已经提到的会话 */
  bound: readonly SessionExtra[]
  /** 选中了：新的字，和要记下的会话 */
  onPick(next: { text: string; caret: number }, extra: SessionExtra): void
  testID: string
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const { store } = useReplica()
  const groups = useKey<SessionGroups>(keys.groups(deviceId))
  const native = useKey<string[]>(keys.nativeChildren(deviceId)) ?? NO_IDS
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const here = useKey<SessionSummary>(sessionId ? keys.summary(deviceId, sessionId) : NONE)

  const hidden = new Set(native)
  const ids = [...new Set(Object.values(groups ?? {}).flat())].filter((id) => !hidden.has(id))
  // 单子开着的这一会儿各会话的摘要不用跟着变：直接取一次，不一个个订阅
  const candidates: SessionCandidate[] = ids.flatMap((id) => {
    const summary = store.get<SessionSummary>(keys.summary(deviceId, id))
    if (!summary) return []
    return [
      {
        id,
        title: mentionTitle(t.text(summary.title)) || id.slice(0, 8),
        harness: summary.harness,
        workspace: workspaces?.find((one) => one.id === summary.workspaceId)?.name ?? '',
        workspaceId: summary.workspaceId,
        cwd: summary.cwd,
        updatedAt: summary.updatedAt,
      },
    ]
  })
  const full = bound.length >= SESSION_MENTION_LIMITS.perMessage
  const shown = full
    ? []
    : sessionHits(candidates, {
        query: trigger.query,
        current: sessionId,
        workspaceId: here?.workspaceId ?? null,
        bound: new Set(bound.map((one) => one.threadId)),
      })
  if (!full && shown.length === 0) return null
  return (
    <View
      testID={`${testID}-mentions`}
      style={[styles.list, { borderColor: c.line2, backgroundColor: c.raised }]}
    >
      <Text style={[styles.head, { color: c.ink3, fontFamily: theme.font.mono }]}>
        {t('at.group.sessions')}
      </Text>
      {full ? (
        <Text style={[styles.note, { color: c.ink2 }]}>
          {t('at.sessions.full', { max: SESSION_MENTION_LIMITS.perMessage })}
        </Text>
      ) : null}
      {shown.map((one) => (
        <Pressable
          key={one.id}
          accessibilityRole="button"
          testID={`${testID}-mention-${one.id}`}
          onPress={() =>
            onPick(insertMention(text, trigger, one.title), {
              kind: 'session',
              threadId: one.id,
              title: one.title,
            })
          }
          style={({ pressed }) => [styles.row, pressed ? { backgroundColor: c.press } : null]}
        >
          <Text numberOfLines={1} style={[styles.title, { color: c.ink }]}>
            {one.title}
          </Text>
          <Text numberOfLines={1} style={[styles.meta, { color: c.ink3 }]}>
            {[one.workspace, nameOf(device, one.harness)].filter(Boolean).join(' · ')}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { marginHorizontal: 12, marginBottom: 8, borderWidth: 1, paddingVertical: 4 },
  head: { fontSize: 11, paddingHorizontal: 10, paddingVertical: 4 },
  note: { fontSize: 13, paddingHorizontal: 10, paddingVertical: 6 },
  row: { paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', gap: 8 },
  title: { flexShrink: 1, fontSize: 15 },
  meta: { flexShrink: 0, maxWidth: '45%', fontSize: 13, marginLeft: 'auto' },
})
