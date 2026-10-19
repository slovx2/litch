// 详情设置几块共用的小件：订阅、一块数据没读到时的那一句、就地说一句的结果、写在哪些文件、
// 登录要填的几栏、在浏览器里打开。
// 手机上没有弹出的提示条：做完、没做成都在原处说一句（照设备详情里管理那一块的做法）。
import type { ChannelErrorShape, HarnessConfigTopicView, HcAuthField, HcFile } from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { Linking, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'

/** 订阅这个 harness 的详情设置（harnessConfig 主题）。开着这一页核心才去设备上读；订不上（设备没了）是 'error' */
export function useHarnessConfig(
  deviceId: string,
  harness: string,
): HarnessConfigTopicView | undefined | 'error' {
  const channel = useChannel()
  const [view, setView] = useState<HarnessConfigTopicView | 'error'>()
  useEffect(() => {
    setView(undefined)
    return channel.subscribe(
      { kind: 'harnessConfig', deviceId, harness },
      {
        snapshot: (data) => setView(data),
        delta: (ops) => {
          const last = ops.at(-1)
          if (last) setView(last.view)
        },
        error: () => setView('error'),
      },
    )
  }, [channel, deviceId, harness])
  return view
}

export type Said = { text: string; bad: boolean } | null

/**
 * 做一件事，就地说一句：没成说原因（返回 undefined），成了按 ok 说（ok 不给就什么都不说）。
 * busy 是正在做
 */
export function useSaid(): {
  said: Said
  setSaid(said: Said): void
  busy: boolean
  run<T>(work: () => Promise<T>, ok?: (result: T) => string | null): Promise<T | undefined>
} {
  const t = useT()
  const [said, setSaid] = useState<Said>(null)
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async <T,>(work: () => Promise<T>, ok?: (result: T) => string | null) => {
      setSaid(null)
      setBusy(true)
      try {
        const result = await work()
        const text = ok?.(result) ?? null
        if (text) setSaid({ text, bad: false })
        return result
      } catch (error) {
        setSaid({ text: t('hc.failed', { reason: whyNot(error, t) }), bad: true })
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [t],
  )
  return { said, setSaid, busy, run }
}

/** 一句话：说明（灰）、结果（绿或红）、提醒（黄） */
export function Note({
  text,
  tone = 'plain',
  testID,
}: {
  text: string
  tone?: 'plain' | 'dim' | 'ok' | 'err' | 'wait'
  testID?: string
}) {
  const { c } = useTheme()
  const color = { plain: c.ink2, dim: c.ink3, ok: c.ok, err: c.err, wait: c.wait }[tone]
  return (
    <Text
      testID={testID}
      accessibilityRole={tone === 'err' ? 'alert' : undefined}
      style={[styles.note, { color }]}
    >
      {text}
    </Text>
  )
}

export function SaidNote({ said, testID }: { said: Said; testID?: string }) {
  return said ? <Note text={said.text} tone={said.bad ? 'err' : 'ok'} testID={testID} /> : null
}

/** 一块数据还没读到、读不成时说一句（读不成给“重试”） */
export function SlotState({
  slot,
  onRetry,
}: {
  slot: { data: unknown; loading: boolean; error: ChannelErrorShape | null }
  onRetry(): void
}) {
  const t = useT()
  if (slot.error && !slot.data) {
    return (
      <View style={styles.pad} testID="hc:slot:error">
        <Note text={t('hc.unreadable', { reason: whyNot(slot.error, t) })} tone="err" />
        <View style={styles.row}>
          <Button kind="plain" label={t('app.retry')} onPress={onRetry} />
        </View>
      </View>
    )
  }
  return <Note text={t('manage.loading')} tone="dim" testID="hc:slot:loading" />
}

/** 这一块落在设备上哪些文件 */
export function Files({ files }: { files: readonly HcFile[] }) {
  const theme = useTheme()
  const t = useT()
  if (files.length === 0) return null
  return (
    <View style={styles.files}>
      <Text style={[styles.small, { color: theme.c.ink3 }]}>{t('hc.files')}</Text>
      {files.map((file) => (
        <Text
          key={file.path}
          selectable
          style={[styles.small, { color: theme.c.ink2, fontFamily: theme.font.mono }]}
        >
          {file.path}
        </Text>
      ))}
    </View>
  )
}

/** 一个开关和它的说明排成一行（只读的列表里也用） */
export function SwitchLine({
  label,
  value,
  disabled,
  testID,
  onChange,
}: {
  label: string
  value: boolean
  disabled?: boolean
  testID?: string
  onChange(next: boolean): void
}) {
  const { c } = useTheme()
  return (
    <View style={styles.switchLine}>
      <Text style={[styles.grow, { color: c.ink, fontSize: 15 }]}>{label}</Text>
      <Switch
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: c.accent, false: c.line2 }}
      />
    </View>
  )
}

/** 登录要填的几栏（API key、粘贴回来的授权码、表单）。值是 id → 字 */
export function AuthFields({
  idPrefix,
  fields,
  values,
  disabled,
  onChange,
}: {
  idPrefix: string
  fields: readonly HcAuthField[]
  values: Record<string, string>
  disabled: boolean
  onChange(values: Record<string, string>): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  return fields.map((field) => {
    const value = values[field.id] ?? ''
    const set = (next: string) => onChange({ ...values, [field.id]: next })
    return (
      <View key={field.id} style={styles.field}>
        <Text style={[styles.label, { color: c.ink2 }]}>
          {t.said(field.title)}
          {field.optional ? <Text style={{ color: c.ink3 }}> {t('hc.optional')}</Text> : null}
        </Text>
        {field.options.length > 0 ? (
          <View style={styles.chips}>
            {field.options.map((option) => (
              <Chip
                key={option.value}
                label={t.said(option.title)}
                on={option.value === value}
                disabled={disabled}
                testID={`${idPrefix}:${field.id}:${option.value}`}
                onPress={() => set(option.value)}
              />
            ))}
          </View>
        ) : (
          <TextInput
            testID={`${idPrefix}:${field.id}`}
            value={value}
            editable={!disabled}
            secureTextEntry={field.secret}
            placeholder={field.placeholder ?? undefined}
            placeholderTextColor={c.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            onChangeText={set}
            style={[
              styles.input,
              {
                color: c.ink,
                backgroundColor: c.raised,
                borderColor: c.line2,
                minHeight: theme.hit,
                fontFamily: theme.font.mono,
              },
            ]}
          />
        )}
      </View>
    )
  })
}

/** 必填的都填了 */
export const filled = (fields: readonly HcAuthField[], values: Record<string, string>): boolean =>
  fields.every((field) => field.optional || (values[field.id] ?? '').trim() !== '')

/** 只交填了的 */
export const inputsOf = (
  fields: readonly HcAuthField[],
  values: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    fields.flatMap((field) =>
      (values[field.id] ?? '') !== '' ? [[field.id, values[field.id] ?? '']] : [],
    ),
  )

/** 在手机的浏览器里打开（只认 http、https） */
export function openOutside(url: string): void {
  if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(() => {})
}

export const styles = StyleSheet.create({
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 6 },
  small: { fontSize: 12, lineHeight: 17 },
  pad: { paddingBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16 },
  files: { paddingHorizontal: 16, paddingVertical: 10, gap: 2 },
  switchLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
})
