// 待答问题在输入框上方；原回合只保留已答记录。
import { wrapQuestionId } from '@litch/core'
import { memo, useSyncExternalStore } from 'react'
import { Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { useTranscript } from '../context'
import { useSessionStore } from './hooks'
export const WrapAskCell = memo(function WrapAskCell({ row }: Props<'wrapAsk'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, sessionId } = useTranscript()
  const store = useSessionStore(deviceId, sessionId)
  const answers = useSyncExternalStore(store.subscribeAnswers, store.getAnswers)
  const answer = answers[wrapQuestionId(row.itemId)]
  if (answer === undefined) return null
  return (
    <View style={{ marginHorizontal: 16, marginVertical: 4 }} testID={`wrap-ask:${row.itemId}`}>
      <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
        {row.ask} · {t('wrap.replied', { label: answer })}
      </Text>
    </View>
  )
})
