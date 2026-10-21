// 写设备设置里“任务卡”按 harness 的开关（harness.<id>.taskCards）。开关存在设备上（设备服务的设置表），
// 写法和设备设置页的保存一样：先订阅这台设备的设置拿到版本号，再对着这个版本写；别处刚改过（版本对不上）就按新的版本再写一次。
// 不依赖 React 和浏览器：桌面的提案卡菜单（task-cards.ts）和手机的提案卡都用这一份。
import {
  type CoreChannel,
  keys,
  type ManageSchema,
  type Replica,
  type SettingsSnapshotView,
  taskCardsSettingKey,
} from '@litch/core'

/** 等设置的订阅拿到第一份（或者出错）。拿不到就是超时 */
const WAIT_MS = 10_000

/** 设备服务没有这一项（旧版本）：界面写明要先升级 */
export class TaskCardsMissing extends Error {}

function snapshotOf(replica: Replica, deviceId: string): Promise<SettingsSnapshotView> {
  const { store } = replica
  const snapshotKey = keys.manageSnapshot(deviceId)
  const errorKey = keys.manageError(deviceId)
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const snapshot = store.get<SettingsSnapshotView>(snapshotKey)
      if (snapshot && store.get<ManageSchema>(keys.manage(deviceId))) {
        resolve(snapshot)
        return true
      }
      const error = store.get<{ message: string }>(errorKey)
      if (error) {
        reject(error)
        return true
      }
      return false
    }
    if (check()) return
    const offs = [snapshotKey, errorKey].map((key) => store.subscribe(key, () => check() && off()))
    const timer = setTimeout(() => {
      off()
      reject(new Error('timeout'))
    }, WAIT_MS)
    const off = () => {
      clearTimeout(timer)
      for (const stop of offs) stop()
    }
  })
}

/** 把这台设备上这个 harness 的任务卡开关写成 on */
export async function writeTaskCards(
  channel: CoreChannel,
  replica: Replica,
  deviceId: string,
  harness: string,
  on: boolean,
): Promise<void> {
  const key = taskCardsSettingKey(harness)
  const close = replica.openManage(deviceId)
  try {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await snapshotOf(replica, deviceId)
      const schema = replica.store.get<ManageSchema>(keys.manage(deviceId))
      if (!schema?.settings.some((spec) => spec.key === key)) throw new TaskCardsMissing(key)
      try {
        await channel.command('device.settings.write', {
          deviceId,
          expectedVersion: snapshot.version,
          edits: [{ key, value: on }],
        })
        return
      } catch (error) {
        // 版本对不上：最新的值已经经订阅到了，对着它再写一次
        if ((error as { code?: string }).code !== 'conflict' || attempt > 0) throw error
      }
    }
  } finally {
    close()
  }
}
