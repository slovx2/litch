// 提案卡、offer 卡、“改了再开始”上的“新工作树”开关：开着子会话有自己的工作树和分支，关着共用当前目录。
// 设备不能建工作树（没有 git、旧设备服务）时不出。初值照设备算的缺省（父会话在工作树里就开着）或模型定的，
// 和桌面的 packages/ui/src/worktrees/WorktreeCheck.tsx 一样。
import { type DeviceView, keys } from '@litch/core'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

/** 设备能不能建工作树：能的话开关算数，按钮把它带上 */
export const useWorktreesOn = (deviceId: string): boolean =>
  useKey<DeviceView>(keys.device(deviceId))?.worktrees === true

export function WorktreeSwitch({
  deviceId,
  value,
  disabled,
  onChange,
  testID,
  inset,
}: {
  deviceId: string
  value: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
  testID: string
  /** 表单页里和别的开关对齐：左右各留 16 */
  inset?: boolean
}) {
  const t = useT()
  const { c, font } = useTheme()
  if (!useWorktreesOn(deviceId)) return null
  return (
    <View style={[styles.row, inset ? styles.inset : null]}>
      <View style={styles.text}>
        <Text style={[styles.label, { color: c.ink, fontSize: font.size.body }]}>
          {t('worktree.check')}
        </Text>
        <Text style={[styles.hint, { color: c.ink3, fontSize: font.size.meta }]}>
          {t('worktree.check.hint')}
        </Text>
      </View>
      <Switch
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={t('worktree.check')}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  inset: { paddingHorizontal: 16 },
  text: { flex: 1, gap: 2 },
  label: {},
  hint: { lineHeight: 18 },
})
