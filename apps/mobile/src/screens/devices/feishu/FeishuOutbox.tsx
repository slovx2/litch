// 飞书应用详情里的“发件”一节：经理经这个应用的发言（新的在前）。每条两行——第一行发到哪、格式与条数、状态、时间，
// 能撤下的（待审批、排队、结果不明）行尾一个小图标按钮；第二行内容摘要，有原因时跟在后面，审批 ID 与尝试次数放在末尾。
// 撤下先确认；已发出的消息不会从飞书撤回（小标题下写明）。“加载更多”按游标读更早的页，只留在本节。
// 以用户身份发的在格式后写“以 某某 身份发”；经 lark-cli 发的再加一行小字写方法、路径和动作。
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  canCancelOutbox,
  type FeishuOutboxEntry,
  type FeishuTone,
  mergeOutbox,
  OUTBOX_TONE,
  type WriteBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import {
  actingUserText,
  cliText,
  outboxReasonText,
  targetLabel,
} from '../../../../../../packages/ui/src/feishu/speech-text.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, SectionLabel } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { Confirm } from '../../../ui/kit/overlays'
import { type Theme, useTheme } from '../../../ui/theme'
import { useFeishuOutbox } from './use-feishu'

function toneColor(c: Theme['c'], tone: FeishuTone): string {
  return tone === 'ok' ? c.ok : tone === 'wait' ? c.wait : tone === 'err' ? c.err : c.ink3
}

export function FeishuOutbox({
  deviceId,
  appId,
  block,
}: {
  deviceId: string
  appId: string
  /** 写操作为什么不能做；null 是能做 */
  block: WriteBlock
}) {
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const view = useFeishuOutbox(deviceId, appId)
  const [older, setOlder] = useState<{ entries: FeishuOutboxEntry[]; next?: string } | null>(null)
  const [canceling, setCanceling] = useState<FeishuOutboxEntry | null>(null)
  const [busy, setBusy] = useState<'more' | string | null>(null)
  const [error, setError] = useState('')
  const latest = view?.value ?? null
  const rows = latest ? mergeOutbox(latest.entries, older?.entries ?? []) : null
  const cursor = older ? older.next : latest?.next
  const snapshotError = view?.error ?? null

  const more = async () => {
    if (!cursor) return
    setBusy('more')
    setError('')
    try {
      const page = await channel.command('feishu.outbox.list', { deviceId, appId, before: cursor })
      setOlder((now) => ({
        entries: [...(now?.entries ?? []), ...page.entries],
        ...(page.next ? { next: page.next } : {}),
      }))
    } catch (failed) {
      setError(feishuFailure(failed, t))
    } finally {
      setBusy(null)
    }
  }
  const cancel = async (entry: FeishuOutboxEntry) => {
    setCanceling(null)
    setBusy(entry.operationId)
    setError('')
    try {
      await channel.command('feishu.outbox.cancel', {
        deviceId,
        appId,
        operationId: entry.operationId,
      })
    } catch (failed) {
      setError(feishuFailure(failed, t))
    } finally {
      setBusy(null)
    }
  }

  const meta = { color: c.ink3, fontSize: font.size.meta }
  const note = [styles.note, meta]
  return (
    <View testID="feishu:outbox">
      <SectionLabel>{t('feishu.outbox.title')}</SectionLabel>
      <Text style={note}>{t('feishu.outbox.note')}</Text>
      {snapshotError ? (
        <Text style={[styles.note, { color: c.err }]}>
          {snapshotError.text ? t.text(snapshotError.text) : snapshotError.message}
        </Text>
      ) : null}
      {error ? (
        <Text testID="feishu:outbox:error" style={[styles.note, { color: c.err }]}>
          {error}
        </Text>
      ) : null}
      {rows === null && !snapshotError ? <Text style={note}>{t('feishu.loading')}</Text> : null}
      {rows?.length === 0 ? <Text style={note}>{t('feishu.outbox.none')}</Text> : null}
      {(rows ?? []).map((entry) => {
        const reason = outboxReasonText(t, entry)
        const tail = [
          entry.reviewId ? t('feishu.outbox.review', { id: entry.reviewId }) : '',
          entry.attempts > 1 ? t('feishu.outbox.attempts', { n: entry.attempts }) : '',
        ].filter(Boolean)
        const kind = [
          t(`feishu.format.${entry.format}`),
          entry.parts > 1 ? t('feishu.outbox.parts', { n: entry.parts }) : '',
          actingUserText(t, entry.actingAs) ?? '',
        ]
          .filter(Boolean)
          .join(' · ')
        const bad = entry.state === 'failed' || entry.state === 'unknown'
        return (
          <View
            key={entry.operationId}
            style={[styles.row, { borderColor: c.line1 }]}
            testID={`feishu:outbox:${entry.operationId}`}
          >
            <View style={styles.line}>
              <Text
                numberOfLines={1}
                style={[
                  styles.shrink,
                  { color: c.ink, fontWeight: '600', fontSize: font.size.meta + 1 },
                ]}
              >
                {targetLabel(t, entry.target)}
              </Text>
              <Text numberOfLines={1} style={[styles.shrink, meta]}>
                {kind}
              </Text>
              <View style={styles.grow} />
              <Text
                testID={`feishu:outbox:state:${entry.operationId}`}
                style={[meta, { color: toneColor(c, OUTBOX_TONE[entry.state]) }]}
              >
                {t(`feishu.outbox.state.${entry.state}`)}
              </Text>
              <Text style={meta}>
                {stamp((entry.sentAt ?? entry.createdAt) * 1000, Date.now(), t.lang)}
              </Text>
              {canCancelOutbox(entry.state) ? (
                <IconButton
                  icon="ban"
                  label={t('feishu.outbox.cancel')}
                  size={14}
                  busy={busy === entry.operationId}
                  disabled={block !== null || busy !== null}
                  testID={`feishu:outbox:cancel:${entry.operationId}`}
                  onPress={() => setCanceling(entry)}
                  style={styles.cancel}
                />
              ) : null}
            </View>
            <Text numberOfLines={2} style={{ color: c.ink, fontSize: font.size.meta }}>
              {entry.summary}
              {reason ? (
                <Text style={{ color: bad ? c.err : c.ink3 }}>{` · ${reason}`}</Text>
              ) : null}
              {tail.length ? (
                <Text style={{ color: c.ink3 }}>{` · ${tail.join(' · ')}`}</Text>
              ) : null}
            </Text>
            {entry.cli ? (
              <Text
                numberOfLines={1}
                testID={`feishu:outbox:cli:${entry.operationId}`}
                style={[meta, { fontFamily: font.mono }]}
              >
                {cliText(t, entry.cli)}
              </Text>
            ) : null}
          </View>
        )
      })}
      {cursor ? (
        <View style={styles.buttons}>
          <Button
            kind="plain"
            label={t('feishu.inbox.more')}
            busy={busy === 'more'}
            disabled={view?.online === false}
            onPress={() => void more()}
          />
        </View>
      ) : null}
      <Confirm
        visible={canceling !== null}
        title={t('feishu.outbox.cancel.title')}
        detail={t(
          canceling?.state === 'unknown'
            ? 'feishu.outbox.cancel.noteUnknown'
            : 'feishu.outbox.cancel.note',
        )}
        confirmLabel={t('feishu.outbox.cancel')}
        danger
        onConfirm={() => {
          if (canceling) void cancel(canceling)
        }}
        onClose={() => setCanceling(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  cancel: { marginVertical: -8, marginRight: -8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16 },
})
