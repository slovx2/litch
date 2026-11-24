// 群设置页的记录摘要与“补更早的消息”。摘要：条数与最早时间；已接入的群另有补历史的进度与结果、最近一次补缺口。
// 补更早的消息：两个 YYYY-MM-DD 输入框（结束默认今天），开始取那天本地零点，结束取次日零点和现在中较早的那个。
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  backfillBlock,
  backfillDefaults,
  backfillWindow,
  FEISHU_BACKFILL_LIMIT,
  type FeishuChat,
  type WriteBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import {
  backfillBlockText,
  backfillSummary,
  gapSummary,
  recordsSummary,
} from '../../../../../../packages/ui/src/feishu/records-text.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Field, SectionLabel } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { InfoLine } from '../parts'

/** 记录摘要：条数与最早时间、补历史、最近补缺口；未接入但留着记录的群另写一句 */
export function FeishuRecordsSummary({ chat }: { chat: FeishuChat }) {
  const t = useT()
  const { c, font } = useTheme()
  const records = chat.records
  const note = [styles.note, { color: c.ink3, fontSize: font.size.meta }]
  if (!records) return chat.access ? <Text style={note}>{t('feishu.records.empty')}</Text> : null
  const backfill = chat.access ? records.backfill : undefined
  const gap = chat.access ? records.gap : undefined
  return (
    <View testID="feishu:records">
      <InfoLine label={t('feishu.records.title')} value={recordsSummary(records, t)} />
      {chat.access ? null : <Text style={note}>{t('feishu.records.keptNote')}</Text>}
      {backfill ? (
        <View style={styles.line}>
          <Text style={[styles.label, { color: c.ink3 }]}>{t('feishu.records.backfill')}</Text>
          <Text
            testID="feishu:records:backfill"
            style={[styles.value, { color: backfill.state === 'failed' ? c.err : c.ink }]}
          >
            {backfillSummary(backfill, t)}
          </Text>
        </View>
      ) : null}
      {gap ? (
        <View style={styles.line}>
          <Text style={[styles.label, { color: c.ink3 }]}>{t('feishu.records.gap')}</Text>
          <Text
            testID="feishu:records:gap"
            style={[styles.value, { color: gap.complete ? c.ink : c.wait }]}
          >
            {gapSummary(gap, t)}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/** 补更早的消息：只给已接入的群 */
export function FeishuBackfillForm({
  deviceId,
  chat,
  block,
  onChat,
}: {
  deviceId: string
  chat: FeishuChat
  block: WriteBlock
  onChat(chat: FeishuChat): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const [days, setDays] = useState(() => backfillDefaults(chat.records, Date.now()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!chat.access) return null
  const why = backfillBlock(chat, block)
  const range = backfillWindow(days.from, days.to, Date.now())
  const problem = 'problem' in range ? range.problem : null
  const start = async () => {
    if (why || 'problem' in range) return
    setBusy(true)
    setError('')
    try {
      const result = await channel.command('feishu.chat.backfill', {
        deviceId,
        appId: chat.appId,
        chatId: chat.chatId,
        start: range.start,
        end: range.end,
      })
      onChat(result.chat)
    } catch (failed) {
      setError(feishuFailure(failed, t))
    } finally {
      setBusy(false)
    }
  }
  const note = [styles.note, { color: c.ink3, fontSize: font.size.meta }]
  return (
    <View testID="feishu:backfill">
      <SectionLabel>{t('feishu.records.more')}</SectionLabel>
      <Text style={note}>{t('feishu.records.moreNote', { max: FEISHU_BACKFILL_LIMIT })}</Text>
      <Field
        label={t('feishu.records.from')}
        value={days.from}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        editable={why === null}
        testID="feishu:backfill:from"
        onChangeText={(from) => setDays({ ...days, from })}
        {...(problem ? { error: t(`feishu.records.problem.${problem}`) } : {})}
      />
      <Field
        label={t('feishu.records.to')}
        value={days.to}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        editable={why === null}
        testID="feishu:backfill:to"
        onChangeText={(to) => setDays({ ...days, to })}
      />
      {why ? (
        <Text testID="feishu:backfill:why" style={[styles.note, { color: c.err }]}>
          {backfillBlockText(why, t)}
        </Text>
      ) : null}
      {error ? <Text style={[styles.note, { color: c.err }]}>{error}</Text> : null}
      <View style={styles.buttons}>
        <Button
          kind="plain"
          label={t('feishu.records.start')}
          testID="feishu:backfill:start"
          busy={busy}
          disabled={why !== null || problem !== null}
          onPress={() => void start()}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  line: { paddingHorizontal: 16, paddingVertical: 6, gap: 2 },
  label: { fontSize: 12 },
  value: { fontSize: 14, lineHeight: 20 },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
})
