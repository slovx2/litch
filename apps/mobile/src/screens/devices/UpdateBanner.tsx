// 设备列表和会话列表顶上的更新横条：有新版本时“有新版本 x · 更新”，点了开始下；下的时候显示进度；下好了拉起系统安装器，
// 安装器没装上、人取消了，横条留着可以再点“安装”。没有新版本时不出；后台查失败了（连不上、清单读不了）也不出，
// 只在设置页的“关于”里说。人点了“更新”之后下下来对不上（签名不同、不是新版本、大小或校验和不对、拉不起安装器）
// 横条留着说为什么，点了到设置页看详情：不然点了“更新”横条就没了，像什么都没发生
// （签名不同最常见：装着的是本机调试钥匙签的包，发布版覆盖不了）。
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { bannerFailure } from '../../update/banner'
import { downloadUpdate, installUpdate } from '../../update/store'
import { useUpdate } from '../../update/use-update'

export function UpdateBanner() {
  const { state } = useUpdate()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const failure = bannerFailure(state)
  if (failure) {
    return (
      <Pressable
        accessibilityRole="button"
        testID={`update:banner:failed:${failure}`}
        onPress={() => navigation.navigate('Settings')}
        style={({ pressed }) => [
          styles.bar,
          {
            minHeight: theme.hit,
            paddingHorizontal: theme.space(4),
            paddingVertical: theme.space(1),
            gap: theme.space(3),
            backgroundColor: pressed ? c.press : c.raised,
            borderBottomColor: c.err,
          },
        ]}
      >
        <Text
          numberOfLines={2}
          style={[styles.label, { color: c.err, fontSize: theme.font.size.meta }]}
        >
          {t(`update.fail.${failure}`)}
        </Text>
        <Text
          style={{
            color: c.accent,
            fontSize: theme.font.size.meta,
            fontFamily: theme.font.mono,
            fontWeight: '600',
          }}
        >
          {`· ${t('update.action.details')}`}
        </Text>
      </Pressable>
    )
  }
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
