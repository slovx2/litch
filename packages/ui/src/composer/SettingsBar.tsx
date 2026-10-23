import {
  type ComposeOptions,
  type DeviceView,
  keys,
  type PermissionPreset,
  type SessionDefaults,
  type SessionSettings,
  STANDARD_SPEED,
  shownEffort,
  shownSpeed,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { downHarness } from '../app/device.ts'
import { useKey, useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { EFFORT_TEXT } from './efforts.ts'
import { Picker, type PickerOption } from './Picker.tsx'

/** 问过的记着，切会话时底栏不用等一下才出来。一台设备上每个 harness 各记各的 */
const known = new Map<string, ComposeOptions>()

/**
 * 在这台设备的这个 harness 上发消息时能选什么。一台设备上有几个 harness 时各问各的：
 * 模型清单是 harness 自己的。设备每连上一次、这个 harness 每恢复可用一次，重新问一遍。
 * 不说是哪个 harness（还不知道）就由核心定。
 */
export function useComposeOptions(deviceId: string, harness?: string): ComposeOptions | null {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  // 能问的时候才问：设备连着，要问的那个 harness 也没有掉线
  const reachable = device?.connection === 'online' && !downHarness(device, harness)
  const key = `${deviceId}\n${harness ?? ''}`
  const [asked, setAsked] = useState<{ key: string; value: ComposeOptions } | null>(null)
  useEffect(() => {
    if (!reachable) return
    const controller = new AbortController()
    channel
      .command(
        'device.composeOptions',
        { deviceId, ...(harness ? { harness } : {}) },
        { signal: controller.signal },
      )
      .then((value) => {
        known.set(key, value)
        setAsked({ key, value })
      })
      // 问不到就不显示选择器，发消息不受影响
      .catch(() => {})
    return () => controller.abort()
  }, [channel, deviceId, harness, key, reachable])
  // 刚换了 harness、新的那份还没问回来：不拿上一个 harness 的清单顶着
  return asked?.key === key ? asked.value : (known.get(key) ?? null)
}

/**
 * 在这台设备的这个 harness 上不带设置新建会话（在 cwd 下）时，对面会用的模型、强度、权限档。
 * 不记着：每次打开新建页、换了设备、harness、工作目录都现问，别处改了配置这里跟着变。
 * 还在问是 undefined；问不到（对面不认识、出错了、眼下问不了）是 null
 */
export function useNewSessionDefaults(
  deviceId: string,
  harness: string | undefined,
  cwd: string | null,
): SessionDefaults | null | undefined {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const reachable = device?.connection === 'online' && !downHarness(device, harness)
  const key = `${deviceId}\n${harness ?? ''}\n${cwd ?? ''}`
  const [asked, setAsked] = useState<{ key: string; value: SessionDefaults | null } | null>(null)
  useEffect(() => {
    if (!reachable) return
    const controller = new AbortController()
    channel
      .command(
        'device.newSessionDefaults',
        { deviceId, ...(harness ? { harness } : {}), cwd },
        { signal: controller.signal },
      )
      .then((value) => setAsked({ key, value }))
      // 问不到就照以前：没选的不显示、不发，由对面用它自己的默认。换了去处被撤掉的那一问不算
      .catch(() => {
        if (!controller.signal.aborted) setAsked({ key, value: null })
      })
    return () => controller.abort()
  }, [channel, deviceId, harness, cwd, key, reachable])
  if (asked?.key === key) return asked.value
  return reachable ? undefined : null
}

/** 认识的权限预设怎么叫、怎么解释 */
const PERMISSION_TEXT: Record<string, { title: MessageKey; note: MessageKey }> = {
  ':read-only': { title: 'permission.readOnly', note: 'permission.readOnly.note' },
  ':workspace': { title: 'permission.workspace', note: 'permission.workspace.note' },
  ':danger-full-access': { title: 'permission.fullAccess', note: 'permission.fullAccess.note' },
}

interface SettingsBarProps {
  options: ComposeOptions | null
  settings: SessionSettings
  /** 这是在新建会话：会话建好之后换不了的那几档权限，这时可以选 */
  fresh?: boolean | undefined
  onChange(patch: Partial<SessionSettings>): void
}

/** 快速档在原生 codex 里的标识（上游 ServiceTier::Fast 的 request_value，老写法是 fast）：界面按自己的语言叫它 */
const FAST_SPEEDS = new Set(['priority', 'fast'])

/** 输入区底栏：模型、强度、速度、权限预设、计划模式。可选值全部来自设备，这里只管显示 */
export function SettingsBar({ options, settings, fresh, onChange }: SettingsBarProps) {
  const t = useT()
  if (!options) return null
  const model = options.models.find((entry) => entry.id === settings.model)

  const pickModel = (id: string) => {
    const next = options.models.find((entry) => entry.id === id)
    // 新模型没有现在这一档强度，就换成它默认的那一档。现在用的本来就是模型的默认档（强度是 null）的，
    // 换了模型还是跟着新模型的默认档走，不替它定一档。新模型一档也没得选的，不发强度（它报的默认档对面不一定认）
    const keep =
      settings.effort === null || next?.efforts.some((effort) => effort.id === settings.effort)
    const fallback = next?.efforts.length ? next.defaultEffort : null
    onChange({ model: id, ...(keep || !fallback ? {} : { effort: fallback }) })
  }

  // 只有一档的（没得选）：它就是现在这一档，对面没说也这样显示
  const sole = options.permissions.length === 1 ? options.permissions[0]?.id : undefined
  const current = settings.permission ?? sole ?? null

  const permission = (preset: PermissionPreset): PickerOption => {
    const text = PERMISSION_TEXT[preset.id]
    // harness 自己声明的预设用它给的标题和说明（两种语言都给了）；没有声明时是内置的三档，界面按标识去说
    const title = preset.title ? t.said(preset.title) : text ? t(text.title) : preset.id
    const note = preset.note ? t.said(preset.note) : text ? t(text.note) : null
    // 会话建好之后换不了的那一档：只在新建时选得了。会话正用着的那一档照常显示
    const locked = !fresh && !preset.switchable && preset.id !== current
    // 要不要先问一遍听声明的。内置的那一档问的话是界面自己的；声明的预设拿它自己的说明来问
    const asked = preset.title ? (note ?? t('permission.confirm.declared')) : null
    return {
      id: preset.id,
      title,
      // 菜单里只列名字，说明在鼠标停上去的提示里；换不了的那一档在名字下面写为什么
      ...(note ? { hint: note } : {}),
      ...(locked ? { disabled: true, note: t('permission.newOnly') } : {}),
      ...(preset.confirm && !locked
        ? {
            confirm: {
              title: t('permission.confirm.title', { name: title }),
              note: asked ?? t('permission.confirm.note'),
              yes: t('permission.confirm.yes'),
              no: t('permission.confirm.no'),
            },
          }
        : {}),
    }
  }

  return (
    <>
      {options.models.length > 0 ? (
        <Picker
          kind="model"
          label={t('composer.model')}
          value={settings.model}
          // 只列名字，不带简介：清单长的时候一眼找得到（所有 harness 一样）
          options={options.models.map((entry) => ({ id: entry.id, title: entry.title }))}
          onPick={pickModel}
          search={t('composer.modelSearch')}
        />
      ) : null}
      {model && model.efforts.length > 0 ? (
        <Picker
          kind="effort"
          label={t('composer.effort')}
          // 对面没报（null）的时候用的是模型自己的默认档，显示那一档
          value={shownEffort(settings.effort, model)}
          options={model.efforts.map((effort) => {
            const key = EFFORT_TEXT[effort.id]
            return {
              id: effort.id,
              title: key ? t(key) : effort.id,
              // 只列名字；对面给的说明放进提示里
              ...(effort.note ? { hint: effort.note } : {}),
            }
          })}
          onPick={(effort) => onChange({ effort })}
        />
      ) : null}
      {model && model.speeds.length > 0 ? (
        <Picker
          kind="speed"
          label={t('composer.speed')}
          // 没选过的时候用的是模型自己的默认档（有的模型默认就是快速），显示那一档
          value={shownSpeed(settings.speed, model)}
          options={[
            // 标准不在对面给的清单里：明着选它要发 default，不然用的是模型的默认档
            { id: STANDARD_SPEED, title: t('composer.speed.standard') },
            // 快速档按界面的语言说；别的档（对面自定的）用它给的名字和说明。说明都只在提示里
            ...model.speeds.map((speed) =>
              FAST_SPEEDS.has(speed.id)
                ? {
                    id: speed.id,
                    title: t('composer.speed.fast'),
                    hint: t('composer.speed.fast.note'),
                  }
                : { id: speed.id, title: speed.title, ...(speed.note ? { hint: speed.note } : {}) },
            ),
          ]}
          onPick={(speed) => onChange({ speed })}
        />
      ) : null}
      {options.permissions.length > 0 ? (
        <Picker
          kind="permission"
          label={t('composer.permission')}
          value={current}
          options={options.permissions.map(permission)}
          onPick={(id) => onChange({ permission: id })}
        />
      ) : null}
      {options.plan ? (
        // 计划模式：一个开关。开着的时候下一条消息先出计划，确认了再动手。
        // 画成带拨块的开关，关着的时候也一直在：光看底栏上有“计划”两个字分不出开没开（别的产品里出现计划标识就是开着）
        <button
          type="button"
          role="switch"
          className="mode-btn"
          data-kind="plan"
          aria-checked={settings.mode === 'plan'}
          title={t(settings.mode === 'plan' ? 'composer.plan.on' : 'composer.plan.off')}
          onClick={() => onChange({ mode: settings.mode === 'plan' ? 'default' : 'plan' })}
        >
          <span className="mode-sw" aria-hidden="true">
            <i />
          </span>
          <span className="mode-name">{t('composer.plan')}</span>
        </button>
      ) : null}
    </>
  )
}
