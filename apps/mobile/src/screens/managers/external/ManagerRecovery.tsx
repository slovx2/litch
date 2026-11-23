import type { ExternalManagerRecovery } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Pressable, StyleSheet, Text } from 'react-native'
import type { RootStackParamList } from '../../../nav/routes'
import { useT } from '../../../ui/i18n'
import { Icon } from '../../../ui/kit/Icon'
import { useTheme } from '../../../ui/theme'

/**
 * 从收件详情或设备页转到经理，沿用经理的能力刷新与接班确认。
 * 跟在受阻原因后面的一行链接（强调色小字加箭头），不占整行按钮。
 */
export function ManagerRecovery({
  deviceId,
  recovery,
  disabled,
  onOpen,
}: {
  deviceId: string
  recovery: ExternalManagerRecovery
  disabled: boolean
  onOpen?: () => void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const color = disabled ? c.ink3 : c.accent
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={{ top: 10, bottom: 10 }}
      testID={`manager-recovery:${recovery.managerId}`}
      onPress={() => {
        onOpen?.()
        navigation.navigate('ManagerConsole', {
          deviceId,
          managerId: recovery.managerId,
          tab: 'console',
        })
      }}
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color, fontSize: font.size.meta, fontWeight: '600' }}>
        {t('mgh.openManagerRecovery')}
      </Text>
      <Icon name="forward" size={12} color={color} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  link: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 2 },
})
