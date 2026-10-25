// 输入框上方的一行（和待办的小按钮排在一起，Composer.tsx）：后台还有任务在跑时出现，只说有几个在跑，整条一起慢呼吸（减少动态效果时不动）。
// 数的是合起来的整张（state.ts）：后台命令、引擎自己派出的子代理、会话树里的子会话，都叫后台任务。
// 点一下进“后台任务”页（src/screens/background/BackgroundScreen.tsx）。人接着说话、新回合在跑时照样在
// （后台的任务没有停），全部跑完就没了。
import { backgroundHint } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Animated, Pressable, StyleSheet, Text } from 'react-native'
import type { SessionStore } from '../../core/session-store'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { useBreath } from '../../ui/kit/breath'
import { useTheme } from '../../ui/theme'
import { useBackgroundEntries } from './state'

// 对话区的过程摘要也用这一份集合（只算后台命令）
export { useSessionBackground } from './state'

export function BackgroundBar({ store }: { store: SessionStore }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [pressed, setPressed] = useState(false)
  const breath = useBreath(pressed)
  const count = backgroundHint(useBackgroundEntries(store))
  const shown = count > 0
  // 底色跟着呼吸一明一暗：呼吸值 1 → 0.35 对应底色的浓淡 0.06 → 0.2
  const glow = breath.interpolate({ inputRange: [0.35, 1], outputRange: [0.2, 0.06] })
  if (!shown) return null
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('background.bar', { count })}
      testID="background:bar"
      onPress={() =>
        navigation.navigate('Background', {
          deviceId: store.deviceId,
          sessionId: store.sessionId,
        })
      }
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.bar, { borderColor: c.accent, borderRadius: theme.radius.m }]}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: c.accent, opacity: glow }]}
      />
      <Animated.View style={[styles.dot, { backgroundColor: c.accent, opacity: breath }]} />
      <Text style={[styles.lead, { color: c.ink }]}>{t('background.bar', { count })}</Text>
      <Text style={{ color: c.ink3 }}>›</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 32,
    paddingHorizontal: 10,
    marginBottom: 6,
    borderWidth: 1,
    overflow: 'hidden',
  },
  dot: { width: 7, height: 7 },
  lead: { fontSize: 13, fontWeight: '500' },
})
