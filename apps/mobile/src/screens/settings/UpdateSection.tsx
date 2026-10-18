// 设置页“关于”里和更新有关的几行：眼下的更新状态、失败原因（失败只在这里说，不弹窗）、“检查更新”和“更新/安装”按钮、
// “自动检查更新”开关（记在 prefs.autoUpdate）。状态从 src/update/store.ts 来。
import { StyleSheet, Switch, Text, View } from 'react-native'
import { useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { checkForUpdate, downloadUpdate, installUpdate } from '../../update/store'
import { useUpdate } from '../../update/use-update'

/** 放在“关于”那一块里面：状态、原因、按钮 */
export function UpdateStatus() {
  const { state, needsPermission } = useUpdate()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const small = { fontSize: theme.font.size.meta, lineHeight: theme.font.size.meta + 5 }
  let line: string
  switch (state.phase) {
    case 'idle':
      line = t('update.state.idle')
      break
    case 'checking':
      line = t('update.state.checking')
      break
    case 'latest':
      line = t('update.state.latest')
      break
    case 'available':
      line = t('update.state.available', { version: state.version })
      break
    case 'downloading':
      line =
        state.progress === undefined
          ? t('update.state.downloading', { version: state.version })
          : `${t('update.state.downloading', { version: state.version })} · ${Math.floor(state.progress * 100)}%`
      break
    case 'ready':
      line = t('update.state.ready', { version: state.version })
      break
    case 'failed':
      line = t('update.fail.title')
      break
  }
  return (
    <View style={{ gap: theme.space(2), marginTop: theme.space(1) }}>
      <Text
        testID={`update:state:${state.phase}`}
        style={[small, { color: state.phase === 'failed' ? c.err : c.ink2 }]}
      >
        {line}
      </Text>
      {state.phase === 'failed' ? (
        <View testID={`update:failure:${state.reason}`} style={{ gap: theme.space(1) }}>
          <Text style={[small, { color: c.err }]}>{t(`update.fail.${state.reason}`)}</Text>
          {state.message ? (
            <Text
              selectable
              style={[small, { color: c.ink3, fontFamily: theme.font.mono }]}
              numberOfLines={3}
            >
              {state.message}
            </Text>
          ) : null}
          <Text style={[small, { color: c.ink3 }]}>{t('update.fail.retry')}</Text>
        </View>
      ) : null}
      {needsPermission ? (
        <Text testID="update:permission" style={[small, { color: c.wait }]}>
          {t('update.permission')}
        </Text>
      ) : null}
      <View style={[styles.buttons, { gap: theme.space(2) }]}>
        {state.phase === 'available' || state.phase === 'ready' ? (
          <Button
            testID="update:go"
            label={t(state.phase === 'ready' ? 'update.action.install' : 'update.action.update')}
            onPress={state.phase === 'ready' ? installUpdate : () => void downloadUpdate()}
          />
        ) : null}
        <Button
          testID="update:check"
          kind="plain"
          label={t('update.action.check')}
          busy={state.phase === 'checking'}
          disabled={state.phase === 'downloading'}
          onPress={() => void checkForUpdate()}
        />
      </View>
    </View>
  )
}

/** “自动检查更新”开关一行，带一句说明 */
export function AutoUpdateSwitch() {
  const { prefs, setPrefs } = useServices()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  return (
    <View>
      <View
        style={[
          styles.switchRow,
          {
            minHeight: theme.hit,
            paddingHorizontal: theme.space(4),
            backgroundColor: c.panel,
            borderColor: c.line2,
          },
        ]}
      >
        <Text style={{ color: c.ink, fontSize: theme.font.size.body, flex: 1 }}>
          {t('update.auto')}
        </Text>
        <Switch
          testID="update:auto"
          value={prefs.autoUpdate}
          onValueChange={(autoUpdate) => setPrefs({ autoUpdate })}
          trackColor={{ true: c.accent, false: c.line2 }}
        />
      </View>
      <Text
        style={{
          color: c.ink3,
          fontSize: theme.font.size.small + 1,
          lineHeight: theme.font.size.small + 6,
          paddingHorizontal: theme.space(4),
          paddingTop: theme.space(1.5),
        }}
      >
        {t('update.auto.note')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
})
