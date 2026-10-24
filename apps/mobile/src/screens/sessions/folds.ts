// 会话列表里收起了哪些组和父会话，按设备记在应用文档目录的 session-folds.json 里，重启之后照上次的样子。
// 形状、开合、清理的算法和桌面侧栏共用（packages/ui 的 sidebar/folds.ts）；不放进设置（prefs）：
// 设置一变整个应用跟着重画，这里只该重画会话列表。
// 不引 react：单测直接载这个文件，订阅交给界面那边的 useSyncExternalStore。
import {
  type DeviceFolds,
  type FoldKind,
  type Folds,
  NO_DEVICE_FOLDS,
  pruneFolds,
  readFolds,
  toggleFold,
} from '../../../../../packages/ui/src/sidebar/folds.ts'
import { jsonFile } from '../../shell/json-file'

const file = jsonFile<unknown>('session-folds.json')
/** 第一次用到才读文件 */
let folds: Folds | null = null
const listeners = new Set<() => void>()

const current = (): Folds => {
  folds ??= readFolds(file.read())
  return folds
}

const publish = (next: Folds) => {
  folds = next
  try {
    file.write(next)
  } catch {
    // 记不下来不影响这一次
  }
  for (const listener of listeners) listener()
}

export const subscribeFolds = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 这台设备上收起了的组和父会话 */
export const foldsOf = (deviceId: string): DeviceFolds => current()[deviceId] ?? NO_DEVICE_FOLDS

export function toggleFolded(deviceId: string, kind: FoldKind, id: string): void {
  publish(toggleFold(current(), deviceId, kind, id))
}

/** 只留还在的组和父会话的记录。没有要去掉的就不写 */
export function pruneFolded(
  deviceId: string,
  keep: Readonly<Record<FoldKind, ReadonlySet<string>>>,
): void {
  const next = pruneFolds(current(), deviceId, keep)
  if (next !== current()) publish(next)
}
