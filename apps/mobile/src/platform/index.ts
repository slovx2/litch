// 手机这一侧给核心的平台能力：远程设备怎么连（SSH，remote.ts）、设备配置和侧栏快照存在哪（device-store.ts）。
// stored 装法（src/shell/boot.ts）用它连真设备。页面要用的钥匙、已知主机直接从 keys.ts、known-hosts.ts 取。
import type { Clock, DeviceStore, RemotePlatform } from '@litch/core'
import { fileDeviceStore } from './device-store'
import { mobileRemote } from './remote'

export interface MobilePlatform {
  remote?: RemotePlatform
  store?: DeviceStore
}

export function mobilePlatform(options: { clock: Clock; version: string }): MobilePlatform {
  return { remote: mobileRemote(options.clock, options.version), store: fileDeviceStore() }
}
