// 手机这一侧给核心的平台能力：远程设备怎么连（SSH）、设备配置和侧栏快照存在哪。连接线负责实现。
// 现在还是空的：核心照样起来，只是没有设备、加不了远程设备（AddDevice 页会提示）。
import type { DeviceStore, RemotePlatform } from '@litch/core'

export interface MobilePlatform {
  remote?: RemotePlatform
  store?: DeviceStore
}

export function mobilePlatform(): MobilePlatform {
  return {}
}
