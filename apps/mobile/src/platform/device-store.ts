// 设备配置和各台设备的侧栏快照、终端的两样小记录：应用文档目录下的几个 JSON 文件（src/shell/json-file.ts，
// 同步读写，先写临时文件再改名）。和桌面端 apps/desktop/src/device-store.mts 一样，里面只有主机、端口、用户名、
// 钥匙的编号和会话的摘要；私钥在安全存储里（keys.ts）。形状由核心来认：读不懂的当作没记过。
// 启动时核心同步读回设备和快照，首屏直接摆出上次的内容，不等网络。
import {
  checkNotes,
  checkSaved,
  checkSnapshot,
  type DeviceStore,
  type SavedDevices,
  type SnapshotStore,
  type TerminalNotesStore,
} from '@litch/core'
import { jsonFile } from '../shell/json-file'

/** 文件名里只留放心的字符。设备标识本来就是核心自己起的，这里再挡一次 */
const safe = (deviceId: string): string => deviceId.replace(/[^A-Za-z0-9_-]/g, '_')

const devicesFile = jsonFile<unknown>('devices.json')
const snapshotFile = (deviceId: string) => jsonFile<unknown>(`snapshot-${safe(deviceId)}.json`)
const terminalFile = (deviceId: string) => jsonFile<unknown>(`terminals-${safe(deviceId)}.json`)

export function fileDeviceStore(): DeviceStore {
  return {
    load(): SavedDevices {
      const raw = devicesFile.read()
      return checkSaved(typeof raw === 'object' && raw !== null ? raw : {})
    },
    save(devices) {
      devicesFile.write({ version: 1, ...devices })
    },
    snapshot(deviceId): SnapshotStore {
      const file = snapshotFile(deviceId)
      return {
        load: () => checkSnapshot(file.read()),
        save: (snapshot) => file.write(snapshot),
      }
    },
    terminals(deviceId): TerminalNotesStore {
      const file = terminalFile(deviceId)
      return {
        load: () => checkNotes(file.read()),
        save: (notes) => file.write(notes),
      }
    },
    forget(deviceId) {
      snapshotFile(deviceId).remove()
      terminalFile(deviceId).remove()
    },
  }
}

/** 现在存着的远程设备（加设备、删钥匙时看哪把钥匙还有人用） */
export const savedRemotes = () => fileDeviceStore().load().remotes
