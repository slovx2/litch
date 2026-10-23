// 输入区底下一排：模型、强度、速度、权限预设、计划模式的开关，和上下文用了多少。可选值全部来自设备，这里只管显示和交回改动
// （会话里走 session.configure，从下一个回合起生效；新建会话页记着，建会话时一起发）。
// 规矩照桌面端（packages/ui/src/composer/SettingsBar.tsx）：换模型时没有现在那一档强度就换成它的默认档；
// 会话建好之后换不了的那几档权限只在新建时能选；声明了要确认的那一档切过去之前先问一句。
import {
  type ComposeOptions,
  type ContextUsage,
  type PermissionPreset,
  type SessionSettings,
  STANDARD_SPEED,
  shownEffort,
  shownSpeed,
} from '@litch/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Confirm } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { effortTitle, permissionText } from './labels'
import { type PickerOption, PickerSheet } from './PickerSheet'

type Open = 'model' | 'effort' | 'speed' | 'permission' | null

/** 快速档在原生 codex 里的标识（上游 ServiceTier::Fast 发的是 priority，老写法是 fast）：按界面的语言叫它 */
const FAST_SPEEDS = new Set(['priority', 'fast'])

function Chip({ label, onPress, testID }: { label: string; onPress?(): void; testID?: string }) {
  const theme = useTheme()
  const { c } = theme
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: c.line2,
          backgroundColor: pressed ? c.press : 'transparent',
        },
      ]}
    >
      <Text numberOfLines={1} style={[styles.chipText, { color: onPress ? c.ink : c.ink3 }]}>
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * 计划模式的开关：前面一个小拨块，后面是名字。关着拨块在左、灰的；开着拨块在右、底是强调色，名字也是。
 * 不做成和别的选择一样的片：光看底栏上有“计划”两个字分不出开没开（别的产品里出现计划标识就是开着）
 */
function PlanSwitch({ on, onPress }: { on: boolean; onPress(): void }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={t('composer.plan')}
      accessibilityHint={t(on ? 'composer.plan.on' : 'composer.plan.off')}
      onPress={onPress}
      testID="settings:plan"
      hitSlop={4}
      style={({ pressed }) => [
        styles.chip,
        styles.mode,
        {
          borderColor: on ? c.line3 : c.line2,
          backgroundColor: pressed ? c.press : 'transparent',
        },
      ]}
    >
      <View
        style={[
          styles.track,
          {
            borderRadius: theme.radius,
            borderColor: on ? c.accentSolid : c.line3,
            backgroundColor: on ? c.accentSolid : c.sunken,
            alignItems: on ? 'flex-end' : 'flex-start',
          },
        ]}
      >
        <View
          style={[
            styles.knob,
            { borderRadius: theme.radius, backgroundColor: on ? c.onAccent : c.ink3 },
          ]}
        />
      </View>
      <Text numberOfLines={1} style={[styles.chipText, { color: on ? c.accent : c.ink3 }]}>
        {t('composer.plan')}
      </Text>
    </Pressable>
  )
}

export function SettingsBar({
  options,
  settings,
  usage,
  fresh,
  onChange,
}: {
  options: ComposeOptions | null
  settings: SessionSettings
  usage?: ContextUsage | null
  /** 这是在新建会话：会话建好之后换不了的那几档权限这时可以选 */
  fresh?: boolean
  onChange(patch: Partial<SessionSettings>): void
}) {
  const t = useT()
  const theme = useTheme()
  const [open, setOpen] = useState<Open>(null)
  const [asking, setAsking] = useState<{ preset: PermissionPreset; title: string } | null>(null)
  const percent =
    usage?.windowTokens && usage.windowTokens > 0
      ? Math.min(100, Math.round((usage.usedTokens / usage.windowTokens) * 100))
      : null
  if (!options) {
    return percent === null ? null : (
      <View style={styles.bar}>
        <Chip label={`${t('compose.context')} ${percent}%`} />
      </View>
    )
  }
  const model = options.models.find((entry) => entry.id === settings.model)
  const effort = model ? shownEffort(settings.effort, model) : null
  // 没选过的时候用的是模型自己的默认档（有的模型默认就是快速）
  const speed = model && model.speeds.length > 0 ? shownSpeed(settings.speed, model) : null
  // 标准不在对面给的清单里：明着选它要发 default，不然用的是模型的默认档。
  // 几张单子都只列名字，不带说明（桌面同样）；只有选不了的那一项在名字下面写为什么
  const speedOptions: PickerOption[] = model
    ? [
        { id: STANDARD_SPEED, title: t('composer.speed.standard') },
        ...model.speeds.map((entry) =>
          FAST_SPEEDS.has(entry.id)
            ? { id: entry.id, title: t('composer.speed.fast') }
            : { id: entry.id, title: entry.title },
        ),
      ]
    : []
  const speedTitle = speedOptions.find((entry) => entry.id === speed)?.title ?? speed
  // 只有一档的（没得选）：它就是现在这一档，对面没说也这样显示
  const sole = options.permissions.length === 1 ? options.permissions[0]?.id : undefined
  const permission = settings.permission ?? sole ?? null
  const currentPreset = options.permissions.find((entry) => entry.id === permission)

  const pickModel = (id: string) => {
    const next = options.models.find((entry) => entry.id === id)
    // 现在用的本来就是模型的默认档（强度是 null）的，换了模型还跟着新模型的默认档走。
    // 新模型一档也没得选的，不发强度（它报的默认档对面不一定认）
    const keep =
      settings.effort === null || next?.efforts.some((entry) => entry.id === settings.effort)
    const fallback = next?.efforts.length ? next.defaultEffort : null
    onChange({ model: id, ...(keep || !fallback ? {} : { effort: fallback }) })
  }
  const pickPermission = (id: string) => {
    const preset = options.permissions.find((entry) => entry.id === id)
    if (!preset) return
    if (preset.confirm) setAsking({ preset, title: permissionText(t, preset).title })
    else onChange({ permission: id })
  }
  const permissionOptions: PickerOption[] = options.permissions.map((preset) => {
    const text = permissionText(t, preset)
    const locked = !fresh && !preset.switchable && preset.id !== permission
    return {
      id: preset.id,
      title: text.title,
      note: locked ? t('permission.newOnly') : null,
      disabled: locked,
    }
  })
  const plan = settings.mode === 'plan'
  return (
    <>
      <View style={styles.bar}>
        {options.models.length > 0 ? (
          <Chip
            testID="settings:model"
            label={`${model?.title ?? settings.model ?? t('composer.model')} ▾`}
            onPress={() => setOpen('model')}
          />
        ) : null}
        {model && model.efforts.length > 0 ? (
          <Chip
            testID="settings:effort"
            label={`${effort ? effortTitle(t, effort) : t('composer.effort')} ▾`}
            onPress={() => setOpen('effort')}
          />
        ) : null}
        {speed !== null ? (
          <Chip
            testID="settings:speed"
            label={`${speedTitle} ▾`}
            onPress={() => setOpen('speed')}
          />
        ) : null}
        {options.permissions.length > 0 ? (
          <Chip
            testID="settings:permission"
            label={`${currentPreset ? permissionText(t, currentPreset).title : t('composer.permission')} ▾`}
            onPress={() => setOpen('permission')}
          />
        ) : null}
        {options.plan ? (
          <PlanSwitch on={plan} onPress={() => onChange({ mode: plan ? 'default' : 'plan' })} />
        ) : null}
        {percent !== null ? (
          <Text style={[styles.usage, { color: theme.c.ink3, fontFamily: theme.font.mono }]}>
            {t('compose.context')} {percent}%
          </Text>
        ) : null}
      </View>
      <PickerSheet
        visible={open === 'model'}
        title={t('composer.model')}
        value={settings.model}
        search={t('composer.modelSearch')}
        // 只列名字，不带简介：清单长的时候一眼找得到（所有 harness 一样）
        options={options.models.map((entry) => ({ id: entry.id, title: entry.title }))}
        onPick={pickModel}
        onClose={() => setOpen(null)}
      />
      <PickerSheet
        visible={open === 'effort'}
        title={t('composer.effort')}
        value={effort}
        options={(model?.efforts ?? []).map((entry) => ({
          id: entry.id,
          title: effortTitle(t, entry.id),
        }))}
        onPick={(id) => onChange({ effort: id })}
        onClose={() => setOpen(null)}
      />
      <PickerSheet
        visible={open === 'speed'}
        title={t('composer.speed')}
        value={speed}
        options={speedOptions}
        onPick={(id) => onChange({ speed: id })}
        onClose={() => setOpen(null)}
      />
      <PickerSheet
        visible={open === 'permission'}
        title={t('composer.permission')}
        value={permission}
        options={permissionOptions}
        onPick={pickPermission}
        onClose={() => setOpen(null)}
      />
      <Confirm
        visible={asking !== null}
        title={t('permission.confirm.title', { name: asking?.title ?? '' })}
        detail={
          asking?.preset.title
            ? (permissionText(t, asking.preset).note ?? t('permission.confirm.declared'))
            : t('permission.confirm.note')
        }
        confirmLabel={t('permission.confirm.yes')}
        danger
        onConfirm={() => asking && onChange({ permission: asking.preset.id })}
        onClose={() => setAsking(null)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  // 放不下就折到下一行：安卓上横着滚的条几乎划不动（实测，320 宽的屏上速度一多，计划就够不着了）
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  chip: { borderWidth: 1, paddingHorizontal: 8, height: 28, justifyContent: 'center' },
  chipText: { fontSize: 13 },
  mode: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6 },
  track: { width: 24, height: 14, borderWidth: 1, padding: 2, justifyContent: 'center' },
  knob: { width: 8, height: 8 },
  usage: { fontSize: 11, marginLeft: 4 },
})
