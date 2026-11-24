// 飞书应用详情里的“群”一节：机器人所在的群（含机器人已不在、但还留着接入设置的群），每群一行：
// 名字、外部群 / 已解散 / 机器人已不在群里、接入状态；点一行进接入或群设置页。小标题右边的刷新让设备先回源飞书。
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  backfilling,
  chatAccessState,
  chatUnavailable,
  type FeishuChat,
  sortChats,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import { useChannel } from '../../../shell/services'
import { type Translator, useT } from '../../../ui/i18n'
import { Row, SectionLabel } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'
import { useFeishuChats } from './use-feishu'

/** 群的标记一句话：外部群、已解散、机器人已不在群里 */
export function chatMarks(chat: FeishuChat, t: Translator): string[] {
  const unavailable = chatUnavailable(chat)
  return [
    ...(chat.external ? [t('feishu.chats.external')] : []),
    ...(unavailable === 'dissolved'
      ? [t('feishu.chats.dissolved')]
      : unavailable === 'botLeft'
        ? [t('feishu.chats.botLeft')]
        : []),
  ]
}

export function FeishuChats({
  deviceId,
  appId,
  online,
  onOpen,
}: {
  deviceId: string
  appId: string
  online: boolean
  onOpen(chat: FeishuChat): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const view = useFeishuChats(deviceId, appId, true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const listed = view?.value?.chats ?? null
  const chats = listed ? sortChats(listed) : null
  const syncedAt = view?.value?.syncedAt ?? null
  const snapshotError = view?.error ?? null

  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      await channel.command('feishu.chat.list', { deviceId, appId, refresh: true })
    } catch (failed) {
      setError(feishuFailure(failed, t))
    } finally {
      setBusy(false)
    }
  }

  const note = [styles.note, { color: c.ink3, fontSize: font.size.meta }]
  const synced = syncedAt
    ? t('feishu.chats.syncedAt', { time: stamp(syncedAt * 1000, Date.now(), t.lang) })
    : t('feishu.chats.never')
  return (
    <View testID="feishu:chats">
      <SectionLabel
        right={
          <IconButton
            icon="reload"
            label={t('feishu.chats.refresh')}
            busy={busy}
            disabled={!online}
            testID="feishu:chats:refresh"
            onPress={() => void refresh()}
          />
        }
      >
        {t('feishu.chats.title')}
      </SectionLabel>
      <Text style={note} testID="feishu:chats:synced">
        {`${synced} · ${t('feishu.chats.note')}`}
      </Text>
      {snapshotError ? (
        <Text style={[styles.note, { color: c.err }]}>
          {snapshotError.text ? t.text(snapshotError.text) : snapshotError.message}
        </Text>
      ) : null}
      {error ? (
        <Text testID="feishu:chats:error" style={[styles.note, { color: c.err }]}>
          {error}
        </Text>
      ) : null}
      {chats === null && !snapshotError ? (
        <Text style={note}>{t(online ? 'feishu.loading' : 'feishu.offline')}</Text>
      ) : null}
      {chats?.length === 0 ? <Text style={note}>{t('feishu.chats.none')}</Text> : null}
      {(chats ?? []).map((chat) => {
        const state = chatAccessState(chat)
        const unavailable = chatUnavailable(chat)
        // 用不了的群不能新接入；已接入的照样能进设置
        const closed = state === 'none' && unavailable !== null
        const detail = [
          ...chatMarks(chat, t),
          t(`feishu.chats.state.${state}`),
          ...(backfilling(chat) ? [t('feishu.chats.backfilling')] : []),
        ].join(' · ')
        // 已解散的整行灰掉
        return (
          <View key={chat.chatId} style={unavailable === 'dissolved' ? styles.off : null}>
            <Row
              testID={`feishu:chat:${chat.chatId}`}
              title={chat.name || chat.chatId}
              detail={closed ? `${detail}\n${t(`feishu.chat.unavailable.${unavailable}`)}` : detail}
              trail={closed ? 'none' : 'forward'}
              {...(closed ? {} : { onPress: () => onOpen(chat) })}
            />
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  off: { opacity: 0.55 },
})
