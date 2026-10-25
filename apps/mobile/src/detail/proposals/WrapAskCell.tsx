// 回合最下方收尾区里的问题（litch_sessions.wrap_up 的 ask）和回复按钮，排在这一回合的建议卡片前面。
// 和桌面端（packages/ui/src/tree/TurnTail.tsx）同一套规矩：点了按钮把它的话当用户消息发出（回合在跑时和输入框一样
// 跟着“回合进行中发消息”的设置，composer/send-mode.ts），下一条用户消息之后按钮失效：点过按钮的折成一行，别的不再画。
// 取哪个、还能不能答用桌面那一份纯函数（tree/tail.ts）。
import { memo, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { actionText, askOpen, pastAskShown } from '../../../../../packages/ui/src/tree/tail.ts'
import { useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { sendFlags, whenRunning } from '../composer/send-mode'
import { useTranscript } from '../context'
import { useSessionStore } from './hooks'

/** 点过的按钮（会话、条目 → 按钮上的字）：单元格回收重建也还记得 */
const clicked = new Map<string, string>()

export const WrapAskCell = memo(function WrapAskCell({ row }: Props<'wrapAsk'>) {
  const { c, font, radius } = useTheme()
  const t = useT()
  const { channel, prefs } = useServices()
  const { deviceId, sessionId } = useTranscript()
  const store = useSessionStore(deviceId, sessionId)
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const memoKey = `${deviceId}:${sessionId}:${row.itemId}`
  const [picked, setPicked] = useState(() => clicked.get(memoKey) ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const last = meta?.lastTurn
  const open =
    last?.id === row.turnId && askOpen(last.itemIds, row.itemId, true, (id) => store.kindOf(id))
  const usable = open && picked === null && meta?.live === true

  const send = (action: { label: string; message?: string }) => {
    if (!usable || busy) return
    setBusy(true)
    setFailure(null)
    channel
      .command('session.send', {
        deviceId,
        sessionId,
        text: actionText(action),
        ...sendFlags(whenRunning(prefs.sendMode, meta?.can)),
      })
      .then(() => {
        clicked.set(memoKey, action.label)
        setPicked(action.label)
      })
      .catch((error: unknown) => setFailure(whyNot(error, t)))
      .finally(() => setBusy(false))
  }

  if (!open) {
    if (!pastAskShown(picked)) return null
    return (
      <View style={styles.past} testID={`wrap-ask:${row.itemId}`}>
        <Text numberOfLines={1} style={{ color: c.ink3, fontSize: font.size.meta }}>
          ? {row.ask}
          {picked ? ` · ${t('wrap.replied', { label: picked })}` : ''}
        </Text>
      </View>
    )
  }
  return (
    <View
      testID={`wrap-ask:${row.itemId}`}
      style={[
        styles.card,
        { borderColor: c.line3, backgroundColor: c.raised, borderRadius: radius.l },
      ]}
    >
      <Text style={[styles.ask, { color: c.ink, fontSize: font.size.body }]}>{row.ask}</Text>
      {row.actions.length > 0 ? (
        <View style={styles.acts}>
          {row.actions.map((action, index) => (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: 按钮的先后就是身份（第一个是推荐的）
              key={index}
              kind={index === 0 ? undefined : 'plain'}
              label={action.label}
              disabled={!usable || busy}
              busy={busy && index === 0}
              onPress={() => send(action)}
              testID={`wrap-ask:${row.itemId}:${index}`}
            />
          ))}
        </View>
      ) : null}
      {picked ? (
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
          {t('wrap.replied', { label: picked })}
        </Text>
      ) : null}
      {failure ? <Text style={{ color: c.err, fontSize: font.size.meta }}>{failure}</Text> : null}
    </View>
  )
})

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 6, padding: 12, gap: 8, borderWidth: 1 },
  ask: { lineHeight: 21 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  past: { marginHorizontal: 16, marginVertical: 4 },
})
