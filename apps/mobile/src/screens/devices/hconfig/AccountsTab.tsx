// 账号这一块（照桌面端的 AccountsTab）：这个 harness 的各个 provider，每个一张卡（ProviderCard）。
// 在用的、登录了的、自定义的、正在登录的列在上面；其余多了收进“连接其他 provider（N 个）”，展开后能按名字筛。
// 有模板的可以加自定义 provider；新增和改用同一张表单（CustomForm），表单开着时这一页只显示它。
import type { HarnessConfigTopicView, HcProvider } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { CustomForm } from './CustomForm'
import { splitProviders } from './logic'
import { ProviderCard } from './ProviderCard'
import { Note, SlotState } from './parts'

export function AccountsTab({
  deviceId,
  harnessId,
  view,
}: {
  deviceId: string
  harnessId: string
  view: HarnessConfigTopicView
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const { c } = theme
  /** 正在新增（provider 是 null）或改的自定义 provider */
  const [custom, setCustom] = useState<{ provider: HcProvider | null } | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  const [filter, setFilter] = useState('')
  const slot = view.providers
  const data = slot.data
  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', { deviceId, harness: harnessId, part: 'providers' })
            .catch(() => {})
        }
      />
    )
  }
  if (custom) {
    return (
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <CustomForm
          deviceId={deviceId}
          harnessId={harnessId}
          data={data}
          provider={custom.provider}
          onClose={() => setCustom(null)}
        />
      </KeyboardAwareScrollView>
    )
  }
  const { primary, others, folded, shown } = splitProviders(
    data.providers,
    view.attempts,
    filter,
    (one) => t.said(one.title),
  )
  const card = (provider: HcProvider) => (
    <ProviderCard
      key={provider.id}
      deviceId={deviceId}
      harnessId={harnessId}
      data={data}
      provider={provider}
      attempts={view.attempts.filter((one) => one.providerId === provider.id)}
      onEdit={() => setCustom({ provider })}
    />
  )
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
      testID="hc:tab:accounts"
    >
      <Note text={t(data.switchable ? 'hc.accounts.note.switch' : 'hc.accounts.note')} tone="dim" />
      {primary.map(card)}
      {folded ? null : others.map(card)}
      {folded ? (
        <View style={styles.others}>
          <View style={styles.pad}>
            <Chip
              label={
                showOthers
                  ? t('hc.provider.othersHide')
                  : t('hc.provider.others', { count: others.length })
              }
              on={showOthers}
              testID="hc:others"
              onPress={() => setShowOthers((open) => !open)}
            />
          </View>
          {showOthers ? (
            <>
              <View style={styles.pad}>
                <TextInput
                  testID="hc:others:filter"
                  value={filter}
                  onChangeText={setFilter}
                  placeholder={t('hc.provider.filter')}
                  placeholderTextColor={c.ink3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.filter,
                    {
                      color: c.ink,
                      backgroundColor: c.raised,
                      borderColor: c.line2,
                      minHeight: theme.hit,
                    },
                  ]}
                />
              </View>
              {shown.length === 0 ? (
                <Note text={t('hc.provider.filterNone')} tone="dim" />
              ) : (
                shown.map(card)
              )}
            </>
          ) : null}
        </View>
      ) : null}
      {data.templates.length > 0 ? (
        <View style={styles.add}>
          <Button
            kind="plain"
            label={t('hc.provider.add')}
            testID="hc:provider:add"
            onPress={() => setCustom({ provider: null })}
          />
        </View>
      ) : null}
    </KeyboardAwareScrollView>
  )
}

const styles = StyleSheet.create({
  others: { paddingVertical: 8, gap: 8 },
  pad: { paddingHorizontal: 16, alignItems: 'flex-start' },
  filter: { alignSelf: 'stretch', borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  add: { padding: 16, paddingBottom: 40, alignItems: 'flex-start' },
})
