// 发消息时能选什么（模型、权限预设、会不会计划模式），新建会话时对面的默认设置。都是现问设备的命令，
// 不是订阅：照桌面端（packages/ui/src/composer/SettingsBar.tsx）的做法，能问的时候才问，问不到就不出选择器。
import {
  type ComposeOptions,
  type DeviceView,
  type HarnessView,
  keys,
  type SessionDefaults,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useChannel, useKey } from '../../shell/services'

/** 会话所属的 harness 现在用不了（不可用或停用了）。设备上没有这个 harness 的记录时不算 */
export function downHarness(
  device: DeviceView | undefined,
  harness: string | undefined,
): HarnessView | null {
  if (!device || !harness) return null
  const found = device.harnesses.find((entry) => entry.id === harness)
  return found && found.state !== 'ready' ? found : null
}

/** 问过的记着，进同一台设备的另一个会话时设置条不用等一下才出来。每个 harness 各记各的 */
const known = new Map<string, ComposeOptions>()

export function useComposeOptions(deviceId: string, harness?: string): ComposeOptions | null {
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const reachable = device?.connection === 'online' && !downHarness(device, harness)
  const key = `${deviceId}\n${harness ?? ''}`
  const [asked, setAsked] = useState<{ key: string; value: ComposeOptions } | null>(null)
  useEffect(() => {
    if (!reachable) return
    let live = true
    channel
      .command('device.composeOptions', { deviceId, ...(harness ? { harness } : {}) })
      .then((value) => {
        known.set(key, value)
        if (live) setAsked({ key, value })
      })
      // 问不到就不显示选择器，发消息不受影响
      .catch(() => {})
    return () => {
      live = false
    }
  }, [channel, deviceId, harness, key, reachable])
  // 刚换了 harness、新的那份还没问回来：不拿上一个 harness 的清单顶着
  return asked?.key === key ? asked.value : (known.get(key) ?? null)
}

/** 不带设置新建会话时对面会用的模型、强度、权限档。不记着，每次现问；还没问到、问不到是 null */
export function useNewSessionDefaults(
  deviceId: string,
  harness: string | undefined,
  cwd: string | null,
): SessionDefaults | null {
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const reachable = device?.connection === 'online' && !downHarness(device, harness)
  const key = `${deviceId}\n${harness ?? ''}\n${cwd ?? ''}`
  const [asked, setAsked] = useState<{ key: string; value: SessionDefaults } | null>(null)
  useEffect(() => {
    if (!reachable) return
    let live = true
    channel
      .command('device.newSessionDefaults', { deviceId, ...(harness ? { harness } : {}), cwd })
      .then((value) => {
        if (live) setAsked({ key, value })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [channel, deviceId, harness, cwd, key, reachable])
  return asked?.key === key ? asked.value : null
}
