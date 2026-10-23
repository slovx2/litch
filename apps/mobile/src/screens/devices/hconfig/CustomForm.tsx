// 按模板新增或改一个自定义 provider（照桌面端的 CustomDialog）：选模板（只在新增、模板不止一个时）、
// 标识（建好后不能改）、模板声明的字段（控件同配置项）。密钥字段不填表示不改。
// 模板说某一栏能从 provider 自己那里拉型号的（Claude 的网关），那一栏下面能拉来勾选、并回清单。
import type { HcProvider, HcProvidersView, HcValue } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import {
  type HcDraft,
  linesOf,
  mergeDiscovered,
  modelLineId,
  parseDraft,
  rawOf,
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
              {template?.discoverModels === field.key ? (
                <Discover
                  deviceId={deviceId}
                  harnessId={harnessId}
                  provider={provider}
                  current={linesOf(
                    String(draft?.kind === 'value' ? draft.value : rawOf(field, stored[field.key])),
                  )}
                  disabled={busy}
                  onPick={(lines) =>
                    setDrafts((current) => ({
                      ...current,
                      [field.key]: { kind: 'value', value: lines.join('\n') },
                    }))
                  }
                />
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

/**
 * 从 provider 自己那里拉型号（照桌面端）：拉到的列成可点的小块，清单里已有的先选上，“写入清单”按选的并回。
 * 要用存着的密钥去问，新加的、还没填密钥的先保存
 */
function Discover({
  deviceId,
  harnessId,
  provider,
  current,
  disabled,
  onPick,
}: {
  deviceId: string
  harnessId: string
  provider: HcProvider | null
  current: string[]
  disabled: boolean
  onPick(lines: string[]): void
}) {
  const t = useT()
  const channel = useChannel()
  const { c } = useTheme()
  const [found, setFound] = useState<{ id: string; title: string | null }[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const ready = provider?.auth.signedIn === true
  const ask = async () => {
    if (!provider) return
    setAsking(true)
    setFailure(null)
    try {
      const { models } = await channel.command('harnessConfig.providers.discoverModels', {
        deviceId,
        harness: harnessId,
        providerId: provider.id,
      })
      const have = new Set(current.map(modelLineId))
      setFound(models)
      setPicked(new Set(models.filter((model) => have.has(model.id)).map((model) => model.id)))
    } catch (error) {
      setFailure(whyNot(error, t))
    }
    setAsking(false)
  }
  const toggle = (id: string) =>
    setPicked((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <View style={styles.discover} testID="hc:custom:discover">
      <View style={styles.discoverActs}>
        <Button
          kind="plain"
          label={t(asking ? 'hc.discover.asking' : 'hc.discover')}
          busy={asking}
          disabled={disabled || !ready}
          testID="hc:custom:discover:ask"
          onPress={() => void ask()}
        />
      </View>
      {ready ? null : (
        <Text style={[styles.small, { color: c.ink3 }]}>{t('hc.discover.needKey')}</Text>
      )}
      {failure ? <Text style={[styles.small, { color: c.err }]}>{failure}</Text> : null}
      {found && found.length === 0 ? (
        <Text style={[styles.small, { color: c.ink3 }]}>{t('hc.discover.none')}</Text>
      ) : null}
      {found && found.length > 0 ? (
        <>
          <View style={styles.chips}>
            {found.map((model) => (
              <Chip
                key={model.id}
                label={
                  model.title && model.title !== model.id
                    ? `${model.id} · ${model.title}`
                    : model.id
                }
                on={picked.has(model.id)}
                disabled={disabled}
                testID={`hc:custom:discover:${model.id}`}
                onPress={() => toggle(model.id)}
              />
            ))}
          </View>
          <View style={styles.discoverActs}>
            <Button
              kind="plain"
              label={t('hc.discover.cancel')}
              testID="hc:custom:discover:cancel"
              onPress={() => setFound(null)}
            />
            <Button
              label={t('hc.discover.apply', { count: picked.size })}
              disabled={disabled}
              testID="hc:custom:discover:apply"
              onPress={() => {
                onPick(mergeDiscovered(current, found, picked))
                setFound(null)
              }}
            />
          </View>
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  discover: { gap: 8 },
  discoverActs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
