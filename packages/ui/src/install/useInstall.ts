// 一台设备上的安装情况（install 主题）：版本、在跑和刚结束的任务。主题开着核心才去问版本；
// 开着的时候顺带现查一次最新版（要联网，设备自己五秒超时），好给“更新到 x.y.z”。
import type { DeviceView, InstallTopicView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useServices } from '../app/services.tsx'

/** 已经现查过最新版的设备：这次运行里不再每打开一次就查一次 */
const checkedLatest = new Set<string>()

/**
 * 订阅这台设备的安装情况。设备不能装（没有这个能力）时不订，回 undefined：
 * 用的地方照原来的样子显示说明
 */
export function useInstall(device: DeviceView | undefined): InstallTopicView | undefined {
  const { channel } = useServices()
  const deviceId = device?.id ?? ''
  const able = device?.install === true && device.connection === 'online'
  const [view, setView] = useState<InstallTopicView>()
  useEffect(() => {
    if (!able) {
      setView(undefined)
      return
    }
    const off = channel.subscribe(
      { kind: 'install', deviceId },
      {
        snapshot: (data) => setView(data),
        delta: (ops) => {
          const last = ops.at(-1)
          if (last) setView(last.view)
        },
        // 订不上就当不能装：照原来的说明显示
        error: () => setView(undefined),
      },
    )
    if (!checkedLatest.has(deviceId)) {
      checkedLatest.add(deviceId)
      channel.command('install.versions', { deviceId, latest: true }).catch(() => {
        // 查不到最新版不挡安装：设备给的原因在版本情况里
      })
    }
    return off
  }, [channel, deviceId, able])
  return able ? view : undefined
}
