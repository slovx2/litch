// 经理控制台的“飞书”页签（经理绑了飞书应用时才有）：分段“待处理 / 已处理”，每条两行——
// 第一行群名、发送人、状态（只在待处理里写）与时间，第二行身份、触发方式和一行正文；点一条就地展开全文与各个时间。
// 只读：处理完由经理用工具标记。列表来自核心的 feishuInbox 快照（最近一页），“加载更多”读更早的页，只留在本页。
import type { ManagerView } from '@litch/core'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  type FeishuInboxEntry,
  type FeishuInboxMessage,
  INBOX_SEGMENTS,
  type InboxSegment,
  type InboxShownStatus,
  inboxChatName,
  inboxShownStatus,
  inboxText,
  mergeInbox,
  queuedCount,
  segmentEntries,
  senderLabel,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import { useChannel } from '../../../shell/services'
import { type Translator, useT } from '../../../ui/i18n'
import { Button, Chip, Empty } from '../../../ui/kit/controls'
import { type Theme, useTheme } from '../../../ui/theme'
import { useFeishuInbox } from '../../devices/feishu/use-feishu'

/** 页签计数：排队中（还没送进经理回合）的条数 */
export function useFeishuSummary(manager: ManagerView, enabled: boolean): number {
  const view = useFeishuInbox(manager.deviceId, manager.id, enabled)
  return queuedCount(view?.value?.entries ?? [])
}

function textLine(t: Translator, message: FeishuInboxMessage | undefined): string {
  const text = inboxText(message)
  if (text.kind === 'text') return text.text
  if (text.kind === 'other') return t('feishu.inbox.text.other', { type: text.msgType })
  return t(`feishu.inbox.text.${text.kind}`)
}

function statusColor(c: Theme['c'], status: InboxShownStatus): string {
  return status === 'notified' ? c.ok : status === 'processed' ? c.ink3 : c.wait
}

function identityColor(c: Theme['c'], identity: FeishuInboxEntry['senderIdentity']): string {
  return identity === 'bound' ? c.ok : identity === 'unknown' ? c.err : c.ink2
}

type Page = {
  entries: FeishuInboxEntry[]
  messages: Record<string, FeishuInboxMessage>
  next?: string
}

export function FeishuInbox({ manager }: { manager: ManagerView }) {
  const t = useT()
  const { c, font, radius } = useTheme()
  const channel = useChannel()
  const [segment, setSegment] = useState<InboxSegment>('open')
  const [open, setOpen] = useState<string | null>(null)
  const [older, setOlder] = useState<Page | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const view = useFeishuInbox(manager.deviceId, manager.id, true)
  const latest = view?.value ?? null
  const all = latest ? mergeInbox(latest, older ?? { entries: [], messages: {} }) : null
  const rows = all ? segmentEntries(all.entries, segment) : []
  const openCount = all ? segmentEntries(all.entries, 'open').length : 0
  const cursor = older ? older.next : latest?.next
  const more = async () => {
    if (!cursor) return
    setLoadingMore(true)
    setError('')
    try {
      const page = await channel.command('feishu.inbox.list', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        before: cursor,
      })
      setOlder((now) => ({
        entries: [...(now?.entries ?? []), ...page.entries],
        messages: { ...now?.messages, ...page.messages },
        ...(page.next ? { next: page.next } : {}),
      }))
    } catch (failed) {
      setError(feishuFailure(failed, t))
    } finally {
      setLoadingMore(false)
    }
  }
  const meta = { color: c.ink3, fontSize: font.size.meta }

  return (
    <View style={styles.fill} testID="feishu-inbox">
      <View style={styles.pills}>
        {INBOX_SEGMENTS.map((key) => (
          <Chip
            key={key}
            radio
            on={segment === key}
            label={
              key === 'open' && openCount
                ? `${t('feishu.inbox.seg.open')} ${openCount}`
                : t(`feishu.inbox.seg.${key}`)
            }
            testID={`feishu-inbox-seg:${key}`}
            onPress={() => {
              setSegment(key)
              setOpen(null)
            }}
          />
        ))}
      </View>
      {view && !view.online && view.fetchedAt ? (
        <Text style={[styles.note, meta]}>{t('feishu.offlineCached')}</Text>
      ) : null}
      <ScrollView style={styles.fill} contentContainerStyle={styles.list}>
        {!view || (!view.value && !view.error) ? (
          <Empty busy title={t('feishu.loading')} />
        ) : view.error && !view.value ? (
          <Text accessibilityRole="alert" style={[styles.note, { color: c.err }]}>
            {view.error.text ? t.text(view.error.text) : view.error.message}
          </Text>
        ) : rows.length === 0 || !all ? (
          <Empty title={t(`feishu.inbox.empty.${segment}`)} />
        ) : (
          rows.map((entry) => {
            const expanded = open === entry.inboxId
            const message = all.messages[entry.inboxId]
            const status = inboxShownStatus(entry)
            const chat = inboxChatName(entry, message)
            const plain = inboxText(message).kind === 'text'
            // 私聊的“群名”已写着私聊，触发方式不再重复
            const trigger =
              chat === null && entry.trigger === 'p2p'
                ? ''
                : t(`feishu.inbox.trigger.${entry.trigger}`)
            return (
              <Pressable
                key={entry.inboxId}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                testID={`feishu-inbox-row:${entry.inboxId}`}
                onPress={() => setOpen(expanded ? null : entry.inboxId)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    borderColor: c.line1,
                    borderRadius: radius.s,
                    backgroundColor: pressed ? c.press : 'transparent',
                  },
                ]}
              >
                <View style={styles.line}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.shrink,
                      { color: c.ink, fontWeight: '600', fontSize: font.size.meta + 1 },
                    ]}
                  >
                    {chat ?? t('feishu.inbox.direct')}
                  </Text>
                  <Text numberOfLines={1} style={[styles.shrink, meta, { color: c.ink2 }]}>
                    {senderLabel(entry)}
                  </Text>
                  <View style={styles.grow} />
                  {segment === 'open' ? (
                    <Text
                      testID={`feishu-inbox-status:${entry.inboxId}`}
                      style={[meta, { color: statusColor(c, status) }]}
                    >
                      {t(`feishu.inbox.status.${status}`)}
                    </Text>
                  ) : null}
                  <Text style={meta}>{stamp(entry.createdAt * 1000, Date.now(), t.lang)}</Text>
                </View>
                <Text numberOfLines={expanded ? undefined : 1} style={meta}>
                  <Text style={{ color: identityColor(c, entry.senderIdentity) }}>
                    {t(`feishu.inbox.identity.${entry.senderIdentity}`)}
                  </Text>
                  {trigger ? ` · ${trigger}` : ''}
                  {expanded ? null : (
                    <Text style={{ color: plain ? c.ink : c.ink3 }}>
                      {' · '}
                      {textLine(t, message)}
                    </Text>
                  )}
                </Text>
                {expanded ? (
                  <View style={styles.detail} testID={`feishu-inbox-detail:${entry.inboxId}`}>
                    <Text
                      selectable
                      style={{ color: plain ? c.ink : c.ink3, fontSize: font.size.body }}
                    >
                      {textLine(t, message)}
                    </Text>
                    {status === 'limited' ? (
                      <Text style={[meta, { color: c.wait }]}>{t('feishu.inbox.limitedNote')}</Text>
                    ) : null}
                    <Text style={meta}>
                      {[
                        `${t('feishu.inbox.detail.sender')} ${senderLabel(entry)}${entry.senderName ? ` · ${entry.senderOpenId}` : ''}`,
                        `${t('feishu.inbox.detail.sent')} ${stamp(entry.createdAt * 1000, Date.now(), t.lang)}`,
                        `${t('feishu.inbox.detail.received')} ${stamp(entry.receivedAt * 1000, Date.now(), t.lang)}`,
                        entry.notifiedAt
                          ? `${t('feishu.inbox.detail.notified')} ${stamp(entry.notifiedAt * 1000, Date.now(), t.lang)}`
                          : '',
                        entry.processedAt
                          ? `${t('feishu.inbox.detail.processed')} ${stamp(entry.processedAt * 1000, Date.now(), t.lang)}`
                          : '',
                        `${t('feishu.inbox.detail.id')} ${entry.inboxId}`,
                      ]
                        .filter(Boolean)
                        .join('\n')}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            )
          })
        )}
        {cursor ? (
          <Button
            kind="plain"
            label={t('feishu.inbox.more')}
            busy={loadingMore}
            disabled={!view?.online}
            onPress={() => void more()}
          />
        ) : null}
        {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  note: { paddingHorizontal: 12, paddingVertical: 4 },
  list: { padding: 12, gap: 8 },
  row: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  detail: { gap: 6, paddingTop: 4 },
})
