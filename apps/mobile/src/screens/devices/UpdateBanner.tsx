// 设备列表顶上的更新横条：有新版本时“有新版本 x · 更新”，点了开始下；下的时候显示进度；下好了拉起系统安装器，
// 安装器没装上、人取消了，横条留着可以再点“安装”。没有新版本、查失败了都不出（失败只在设置页的“关于”里说）。
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { downloadUpdate, installUpdate } from '../../update/store'
import { useUpdate } from '../../update/use-update'

export function UpdateBanner() {
  const { state } = useUpdate()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  if (state.phase !== 'available' && state.phase !== 'downloading' && state.phase !== 'ready') {
    return null
  }
  const { version } = state
  const downloading = state.phase === 'downloading'
  const percent =
    downloading && state.progress !== undefined ? Math.floor(state.progress * 100) : null
  const label =
    state.phase === 'available'
      ? t('update.banner.available', { version })
      : downloading
        ? t('update.banner.downloading', { version })
        : t('update.banner.ready', { version })
  const action = downloading
    ? percent === null
      ? '…'
      : `${percent}%`
    : t(state.phase === 'ready' ? 'update.action.install' : 'update.action.update')
  const onPress = state.phase === 'ready' ? installUpdate : () => void downloadUpdate()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: downloading, busy: downloading }}
      disabled={downloading}
      testID={`update:banner:${state.phase}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.bar,
        {
          minHeight: theme.hit,
          paddingHorizontal: theme.space(4),
          gap: theme.space(3),
          backgroundColor: pressed ? c.press : c.raised,
          borderBottomColor: c.line2,
        },
      ]}
    >
      {downloading ? (
        <View style={[styles.progress, { backgroundColor: c.sel, width: `${percent ?? 0}%` }]} />
      ) : null}
      <Text
        numberOfLines={1}
        style={[styles.label, { color: c.ink, fontSize: theme.font.size.meta }]}
      >
        {label}
      </Text>
      <Text
        testID="update:banner:action"
        style={{
          color: downloading ? c.ink2 : c.accent,
          fontSize: theme.font.size.meta,
          fontFamily: theme.font.mono,
          fontWeight: '600',
        }}
      >
        {downloading ? action : `· ${action}`}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    overflow: 'hidden',
  },
  progress: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  label: { flex: 1 },
})
