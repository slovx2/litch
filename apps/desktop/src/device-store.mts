// 设备配置和各台设备的侧栏快照存在哪：用户数据目录下的几个 JSON 文件。
// 里面只有主机名、别名、端口、用户名、密钥文件的路径和会话的摘要；没有密码，没有密钥的内容。
// 写的时候先写到旁边再改名，断电也不会留下半个文件。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkNotes,
  checkSaved,
  checkSnapshot,
  type DeviceSnapshot,
  type DeviceStore,
  type MachineLogStore,
  type SavedDevices,
  type SnapshotStore,
  type TerminalNotes,
  type TerminalNotesStore,
} from '@litch/core'

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // 没有这个文件，或者内容坏了：当作没存过
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  const next = `${path}.${process.pid}.tmp`
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(next, path)
}

/** 快照文件名里只留放心的字符。设备标识本来就是核心自己起的，这里再挡一次 */
const safe = (deviceId: string): string => deviceId.replace(/[^A-Za-z0-9_-]/g, '_')

/** dir 是用户数据目录 */
export function fileDeviceStore(dir: string): DeviceStore {
  const devicesFile = join(dir, 'devices.json')
  const snapshotDir = join(dir, 'snapshots')
  const snapshotFile = (deviceId: string) => join(snapshotDir, `${safe(deviceId)}.json`)
  // 和设备上的终端有关、只记在这台电脑上的两样：改过的名字、留在设备上没开成标签的
  const terminalDir = join(dir, 'terminals')
  const terminalFile = (deviceId: string) => join(terminalDir, `${safe(deviceId)}.json`)
  // 远程设备在这台电脑上的操作记录（litch_machine，08 号 3.4）：只存在本机，条数由核心限着
  const machineDir = join(dir, 'machine-log')
  const machineFile = (deviceId: string) => join(machineDir, `${safe(deviceId)}.json`)

  return {
    load(): SavedDevices {
      const raw = readJson(devicesFile)
      return checkSaved(typeof raw === 'object' && raw !== null ? raw : {})
    },

    save(devices) {
      mkdirSync(dir, { recursive: true })
      writeJson(devicesFile, { version: 1, ...devices })
    },

    snapshot(deviceId): SnapshotStore {
      return {
        // 形状由核心来认：读不懂的（文件坏了，或者是以前的版本记的）当作没记过
        load: (): DeviceSnapshot | null => checkSnapshot(readJson(snapshotFile(deviceId))),
        save(snapshot) {
          mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
          writeJson(snapshotFile(deviceId), snapshot)
        },
      }
    },

    terminals(deviceId): TerminalNotesStore {
      return {
        load: (): TerminalNotes | null => checkNotes(readJson(terminalFile(deviceId))),
        save(notes) {
          mkdirSync(terminalDir, { recursive: true, mode: 0o700 })
          writeJson(terminalFile(deviceId), notes)
        },
      }
    },

    machineLog(deviceId): MachineLogStore {
      return {
        load: () => readJson(machineFile(deviceId)),
        save(entries) {
          mkdirSync(machineDir, { recursive: true, mode: 0o700 })
          writeJson(machineFile(deviceId), entries)
        },
      }
    },

    forget(deviceId) {
      rmSync(snapshotFile(deviceId), { force: true })
      rmSync(terminalFile(deviceId), { force: true })
      rmSync(machineFile(deviceId), { force: true })
    },
  }
}
