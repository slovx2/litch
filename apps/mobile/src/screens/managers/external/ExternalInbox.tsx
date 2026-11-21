// 经理控制台的 GitHub 页签：三页签（待分拣 / 已处理 / 被挡下），待分拣可按原因筛，已处理可只看已提醒。
// 列表一行只放主题、种类、发起人资格、时间和提醒状态；证据与处置在点开的底部抽屉里（InboxDetail）。
import type { ExternalInboxEvent, ManagerView } from '@litch/core'
import { useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import {
  groupInbox,
  INBOX_TABS,
  type InboxTab,
  inboxFilter,
  subjectLabel,
} from '../../../../../../packages/ui/src/external/model.ts'
import { useChannel } from '../../../shell/services'
import { type Key, useT } from '../../../ui/i18n'
import { Button, Chip, Empty } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { Sheet } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'
import { InboxDetail } from './InboxDetail'
import { deliveryLabel, failureText, kindLabel, openGithub, reasonLabel, roleLabel } from './labels'
import { useExternalInbox } from './use-external'

/** 页签计数：待分拣的候选数（按候选聚合，不按事件） */
export function useGithubPending(manager: ManagerView, enabled: boolean): number {
  const view = useExternalInbox(manager.deviceId, inboxFilter('pending', manager.id), enabled)
  return view?.value ? groupInbox(view.value.entries).length : 0
}

export function ExternalInbox({ manager, disabled }: { manager: ManagerView; disabled: boolean }) {
  const t = useT()
  const theme = useTheme()
  const { c, font, radius } = theme
  const channel = useChannel()
  const [tab, setTab] = useState<InboxTab>('pending')
  const [reason, setReason] = useState<string | undefined>()
  const [onlyNotified, setOnlyNotified] = useState(false)
  const [picking, setPicking] = useState(false)
  const [opened, setOpened] = useState<ExternalInboxEvent | null>(null)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const filter = inboxFilter(tab, manager.id, { reason, onlyNotified })
  const view = useExternalInbox(manager.deviceId, filter, true)
  // 见过的原因都留在筛选单里，选了一个原因后其余的不会消失
  const reasons = useRef(new Set<string>())
  for (const entry of view?.value?.entries ?? [])
    if (entry.status === 'pending_triage' && entry.reason) reasons.current.add(entry.reason)
  const rows = groupInbox(view?.value?.entries ?? [])
  const more = async () => {
    setLoadingMore(true)
    setError('')
    try {
      await channel.command('external.inbox.more', { deviceId: manager.deviceId, filter })
    } catch (failed) {
      setError(failureText(t, failed))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <View style={styles.fill} testID="github-inbox">
      <View style={styles.bar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.fill}
          contentContainerStyle={styles.pills}
        >
          {INBOX_TABS.map((key) => (
            <Chip
              key={key}
              radio
              on={tab === key}
              label={t(`mgh.inbox.${key}` as Key)}
              testID={`github-tab:${key}`}
              onPress={() => {
                setTab(key)
                setOpened(null)
              }}
            />
          ))}
        </ScrollView>
        {tab === 'pending' ? (
          <IconButton
            icon="filter"
            label={`${t('mgh.inbox.reason')}: ${reason ? reasonLabel(t, reason) : t('mgh.inbox.reasonAll')}`}
            selected={Boolean(reason)}
            {...(reason ? { color: c.accent } : {})}
            testID="github-reason"
            onPress={() => setPicking(true)}
          />
        ) : tab === 'processed' ? (
          <Chip
            on={onlyNotified}
            label={t('mgh.inbox.notifiedOnly')}
            testID="github-notified-only"
            onPress={() => setOnlyNotified(!onlyNotified)}
          />
        ) : null}
      </View>
      {view && !view.online && view.fetchedAt ? (
        <Text style={[styles.note, { color: c.ink3, fontSize: font.size.meta }]}>
          {t('mgh.inbox.cached', { time: stamp(view.fetchedAt, Date.now(), t.lang) })}
        </Text>
      ) : null}
      <ScrollView style={styles.fill} contentContainerStyle={styles.list}>
        {!view || (!view.value && !view.error) ? (
          <Empty busy title={t('mgh.inbox.loading')} />
        ) : view.error && !view.value ? (
          <Text accessibilityRole="alert" style={[styles.note, { color: c.err }]}>
            {t.text(view.error.text ?? view.error.message)}
          </Text>
        ) : rows.length === 0 ? (
          <Empty title={t('mgh.inbox.empty')} />
        ) : (
          rows.map(({ head, count }) => (
            <View
              key={head.intakeId ?? head.eventKey}
              style={[styles.row, { borderColor: c.line1, borderRadius: radius.s }]}
            >
              <Pressable
                accessibilityRole="button"
                testID={`github-row:${head.eventKey}`}
                onPress={() => setOpened(head)}
                style={({ pressed }) => [
                  styles.main,
                  { backgroundColor: pressed ? c.press : 'transparent' },
                ]}
              >
                <View style={styles.line}>
                  <Text
                    numberOfLines={1}
                    style={{ color: c.ink, fontWeight: '600', fontSize: font.size.meta + 1 }}
                  >
                    {subjectLabel(head.subject)}
                  </Text>
                  <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
                    {kindLabel(t, head.kind)}
                    {count > 1 ? ` · ${t('mgh.inbox.events', { n: count })}` : ''}
                  </Text>
                </View>
                <Text numberOfLines={1} style={{ color: c.ink3, fontSize: font.size.meta }}>
                  {[
                    roleLabel(t, head.actorRoleAtCheck),
                    stamp(head.occurredAt * 1000, Date.now(), t.lang),
                    head.delivery ? deliveryLabel(t, head.delivery) : '',
                    head.reason &&
                    (tab !== 'processed' ||
                      head.reason === 'external_closed' ||
                      head.reason === 'external_merged')
                      ? reasonLabel(t, head.reason)
                      : '',
                    head.issueId ?? '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Pressable>
              <IconButton
                icon="external"
                size={16}
                label={t('mgh.open')}
                onPress={() => openGithub(head.eventUrl)}
              />
            </View>
          ))
        )}
        {view?.value?.nextBeforeSeq ? (
          <Button
            kind="plain"
            label={t('mgh.inbox.more')}
            busy={loadingMore}
            disabled={!view.online}
            onPress={() => void more()}
          />
        ) : null}
        {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
      </ScrollView>
      {opened ? (
        <InboxDetail
          manager={manager}
          head={opened}
          access={view?.access}
          disabled={disabled || !view?.online}
          onClose={() => setOpened(null)}
        />
      ) : null}
      <Sheet
        visible={picking}
        title={t('mgh.inbox.reason')}
        onClose={() => setPicking(false)}
        actions={[
          {
            label: t('mgh.inbox.reasonAll'),
            selected: !reason,
            onPress: () => setReason(undefined),
          },
          ...[...reasons.current].map((one) => ({
            label: reasonLabel(t, one),
            selected: reason === one,
            onPress: () => setReason(one),
          })),
        ]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  pills: { alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  note: { paddingHorizontal: 12, paddingVertical: 4 },
  list: { padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  main: { flex: 1, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
})
