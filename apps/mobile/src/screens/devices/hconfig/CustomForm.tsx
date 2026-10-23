// 按模板新增或改一个自定义 provider（照桌面端的 CustomDialog）：选模板（只在新增、模板不止一个时）、
// 标识（建好后不能改）、模板声明的字段（控件同配置项）。密钥字段不填表示不改。
import type { HcProvider, HcProvidersView, HcValue } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import {
  type HcDraft,
  parseDraft,
} from '../../../../../../packages/ui/src/devices/hconfig/logic.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip, SectionLabel } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { HcControl } from './HcControl'
import { Note } from './parts'

export function CustomForm({
  deviceId,
  harnessId,
  data,
  provider,
  onClose,
}: {
  deviceId: string
  harnessId: string
  data: HcProvidersView
  /** 改的是哪一个；新增是 null */
  provider: HcProvider | null
  onClose(): void
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const { c } = theme
  const [templateId, setTemplateId] = useState(provider?.templateId ?? data.templates[0]?.id ?? '')
  const [providerId, setProviderId] = useState(provider?.id ?? '')
  const [drafts, setDrafts] = useState<Record<string, HcDraft>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const template = data.templates.find((one) => one.id === templateId)
  const stored = provider?.definition ?? {}
  const definition: Record<string, HcValue> = {}
  let wrong = false
  for (const field of template?.fields ?? []) {
    const draft = drafts[field.key]
    if (!draft) continue
    const parsed = parseDraft(field, draft)
    if (!parsed.ok) wrong = true
    else if (parsed.value !== null) definition[field.key] = parsed.value
  }
  const ready = !!template && /^[A-Za-z0-9_-]+$/.test(providerId.trim()) && !wrong

  const submit = async () => {
    if (!template) return
    setBusy(true)
    setFailure(null)
    try {
      await channel.command('harnessConfig.providers.upsert', {
        deviceId,
        harness: harnessId,
        providerId: providerId.trim(),
        templateId: template.id,
        definition,
        expectedVersion: data.version,
      })
      onClose()
    } catch (error) {
      setBusy(false)
      setFailure(whyNot(error, t))
    }
  }
  return (
    <View testID="hc:custom">
      <SectionLabel>
        {provider ? t('hc.provider.edit', { name: t.said(provider.title) }) : t('hcm.custom.title')}
      </SectionLabel>
      <View style={styles.body}>
        {provider === null && data.templates.length > 1 ? (
          <View style={styles.field}>
            <Text style={[styles.label, { color: c.ink2 }]}>{t('hc.provider.template')}</Text>
            <View style={styles.chips}>
              {data.templates.map((one) => (
                <Chip
                  key={one.id}
                  label={t.said(one.title)}
                  on={one.id === templateId}
                  testID={`hc:custom:template:${one.id}`}
                  onPress={() => {
                    setTemplateId(one.id)
                    setDrafts({})
                  }}
                />
              ))}
            </View>
          </View>
        ) : null}
        {template?.description ? (
          <Text style={[styles.small, { color: c.ink3 }]}>{t.said(template.description)}</Text>
        ) : null}
        <View style={styles.field}>
          <Text style={[styles.label, { color: c.ink2 }]}>{t('hc.provider.id')}</Text>
          <TextInput
            testID="hc:custom:id"
            value={providerId}
            editable={provider === null && !busy}
            onChangeText={setProviderId}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[
              styles.input,
              {
                color: c.ink,
                backgroundColor: c.raised,
                borderColor: c.line2,
                borderRadius: theme.radius.m,
                minHeight: theme.hit,
                fontFamily: theme.font.mono,
                opacity: provider === null ? 1 : 0.6,
              },
            ]}
          />
          <Text style={[styles.small, { color: c.ink3 }]}>{t('hc.provider.id.note')}</Text>
        </View>
        {(template?.fields ?? []).map((field) => {
          const draft = drafts[field.key]
          const parsed = draft ? parseDraft(field, draft) : null
          return (
            <View style={styles.field} key={field.key}>
              <Text style={[styles.label, { color: c.ink2 }]}>{t.said(field.title)}</Text>
              <HcControl
                spec={field}
                stored={field.key in stored ? stored[field.key] : undefined}
                draft={draft}
                disabled={busy}
                wrong={parsed !== null && !parsed.ok}
                testID={`hc:custom:${field.key}`}
                onDraft={(next) =>
                  setDrafts((current) => {
                    const rest = { ...current }
                    // 密钥清空了等于不改
                    if (field.type === 'secret' && next.kind === 'value' && next.value === '')
                      delete rest[field.key]
                    else rest[field.key] = next
                    return rest
                  })
                }
              />
              {field.description ? (
                <Text style={[styles.small, { color: c.ink3 }]}>{t.said(field.description)}</Text>
              ) : null}
              {parsed && !parsed.ok ? (
                <Text style={[styles.small, { color: c.err }]}>{t(parsed.problem)}</Text>
              ) : null}
            </View>
          )
        })}
      </View>
      {failure ? <Note text={failure} tone="err" testID="hc:custom:failure" /> : null}
      <View style={styles.acts}>
        <Button kind="plain" label={t('app.cancel')} testID="hc:custom:cancel" onPress={onClose} />
        <Button
          label={t(busy ? 'manage.saving' : 'manage.save')}
          busy={busy}
          disabled={!ready}
          testID="hc:custom:save"
          onPress={() => void submit()}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 4, gap: 14 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  small: { fontSize: 12, lineHeight: 17 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  acts: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    padding: 16,
    paddingBottom: 40,
  },
})
