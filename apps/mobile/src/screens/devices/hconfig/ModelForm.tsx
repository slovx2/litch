// 模型清单里新增、改一项（照桌面端的 ModelDialog）：先挑底稿（自带目录里的模型，多了可以按名字筛），
// 再选原样用、还是以它为底稿换模型名、显示名、上下文窗口（留空照底稿）。只改草稿，保存在清单页底下。
import type { HcModelBase, HcModelEntry } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import {
  entryOfForm,
  type ModelForm as Form,
  filterBases,
  formOfEntry,
  shortWindow,
} from '../../../../../../packages/ui/src/devices/hconfig/models.ts'
import { useT } from '../../../ui/i18n'
import { Button, Chip, Field, Row, SectionLabel } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'

/** 底稿多过这么多才给筛选框（照桌面端） */
const FILTER_FROM = 6

export function ModelForm({
  bases,
  entry,
  taken,
  onDone,
  onClose,
}: {
  bases: readonly HcModelBase[]
  /** 改的那一项；新增是 null */
  entry: HcModelEntry | null
  /** 清单里别的项已经用了的模型名 */
  taken: ReadonlySet<string>
  onDone(entry: HcModelEntry): void
  onClose(): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const [form, setForm] = useState<Form>(() => formOfEntry(entry, bases, taken))
  const [query, setQuery] = useState('')
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }))
  const base = bases.find((one) => one.id === form.base) ?? null
  const result = entryOfForm(form, bases, taken)
  const shown = filterBases(bases, query)
  // 选中的底稿不在筛出来的里面也留着它，免得看不见选的是谁
  const options = base && !shown.includes(base) ? [base, ...shown] : shown
  // 模型名还空着时不急着说“要填”
  const problem =
    !result.ok && !(result.problem === 'hc.models.bad.id' && form.id.trim() === '') ? result : null
  const problemText = (field: string) =>
    problem && !problem.ok && problem.field === field
      ? t(problem.problem, { id: form.mode === 'same' ? form.base : form.id.trim() })
      : undefined

  const pick = (next: HcModelBase) => {
    // 自定义时模型名还是原底稿的名字（没改过）：跟着换
    const followId = form.mode === 'custom' && (form.id === '' || form.id === form.base)
    set({ base: next.id, ...(followId ? { id: next.id } : {}) })
  }
  const mode = (next: Form['mode']) =>
    set({ mode: next, ...(next === 'custom' && form.id === '' ? { id: form.base } : {}) })
  const baseProblem = problemText('base')

  return (
    <View testID="hc:modelForm">
      <SectionLabel>
        {entry ? t('hc.models.edit', { id: entry.id }) : t('hc.models.add')}
      </SectionLabel>
      <Text style={[styles.label, styles.pad, { color: c.ink2 }]}>{t('hc.models.base')}</Text>
      {bases.length > FILTER_FROM ? (
        <View style={styles.pad}>
          <TextInput
            testID="hc:modelForm:filter"
            value={query}
            onChangeText={setQuery}
            placeholder={t('hc.models.base.filter')}
            placeholderTextColor={c.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[
              styles.input,
              {
                color: c.ink,
                backgroundColor: c.raised,
                borderColor: c.line2,
                minHeight: theme.hit,
              },
            ]}
          />
        </View>
      ) : null}
      <View style={[styles.list, { borderColor: c.line2 }]}>
        {options.length === 0 ? (
          <Text style={[styles.small, styles.pad, { color: c.ink3 }]}>
            {t('hc.models.base.none')}
          </Text>
        ) : (
          options.map((one) => {
            const meta = [
              one.contextWindow === null ? '' : shortWindow(one.contextWindow),
              taken.has(one.id) ? t('hc.models.base.taken') : '',
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <Row
                key={one.id}
                title={one.displayName}
                meta={meta || undefined}
                detail={one.id}
                selected={one.id === form.base}
                testID={`hc:modelForm:base:${one.id}`}
                onPress={() => pick(one)}
              />
            )
          })
        )}
      </View>
      {baseProblem ? (
        <Text style={[styles.small, styles.pad, { color: c.err }]} testID="hc:modelForm:problem">
          {baseProblem}
        </Text>
      ) : null}

      <View style={[styles.pad, styles.field]}>
        <Text style={[styles.label, { color: c.ink2 }]}>{t('hc.models.mode')}</Text>
        <View style={styles.chips}>
          {(['same', 'custom'] as const).map((one) => (
            <Chip
              key={one}
              label={t(one === 'same' ? 'hc.models.mode.same' : 'hc.models.mode.custom')}
              on={form.mode === one}
              testID={`hc:modelForm:mode:${one}`}
              onPress={() => mode(one)}
            />
          ))}
        </View>
        <Text style={[styles.small, { color: c.ink3 }]}>
          {form.mode === 'same'
            ? t('hc.models.mode.same.note', { base: base?.displayName ?? form.base })
            : t('hc.models.mode.custom.note', { base: base?.displayName ?? form.base })}
        </Text>
      </View>

      {form.mode === 'custom' ? (
        <View style={styles.fields}>
          <Field
            label={t('hc.models.id')}
            testID="hc:modelForm:id"
            value={form.id}
            onChangeText={(id) => set({ id })}
            spellCheck={false}
            style={{ fontFamily: theme.font.mono }}
            hint={t('hc.models.id.note')}
            error={problemText('id')}
          />
          <Field
            label={t('hc.models.displayName')}
            testID="hc:modelForm:displayName"
            value={form.displayName}
            onChangeText={(displayName) => set({ displayName })}
            placeholder={base?.displayName ?? ''}
            hint={t('hc.models.displayName.note')}
          />
          <Field
            label={t('hc.models.window')}
            testID="hc:modelForm:window"
            value={form.contextWindow}
            onChangeText={(contextWindow) => set({ contextWindow })}
            placeholder={base?.contextWindow != null ? String(base.contextWindow) : ''}
            spellCheck={false}
            style={{ fontFamily: theme.font.mono }}
            hint={
              base?.contextWindow != null
                ? t('hc.models.window.note', { value: shortWindow(base.contextWindow) })
                : t('hc.models.window.noteNone')
            }
            error={problemText('contextWindow')}
          />
        </View>
      ) : null}

      <View style={styles.acts}>
        <Button
          kind="plain"
          label={t('app.cancel')}
          testID="hc:modelForm:cancel"
          onPress={onClose}
        />
        <Button
          label={entry ? t('hc.models.dialog.apply') : t('hc.models.dialog.add')}
          disabled={!result.ok}
          testID="hc:modelForm:done"
          onPress={() => {
            if (result.ok) onDone(result.entry)
          }}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16 },
  field: { gap: 6, paddingTop: 14 },
  fields: { gap: 14, padding: 16 },
  label: { fontSize: 13, fontWeight: '500', paddingBottom: 6 },
  small: { fontSize: 12, lineHeight: 17 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, paddingHorizontal: 12, fontSize: 14, marginBottom: 8 },
  list: { borderTopWidth: StyleSheet.hairlineWidth },
  acts: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    padding: 16,
    paddingBottom: 40,
  },
})
