// 侧栏“只看某个 harness 的会话”：能挑哪几个、挑中的那个怎么称呼、一组会话里留哪些。
// 挑的是哪个记在 state.ts 里（界面本地）；这里只管算，不碰页面，好单独测。
import type { DeviceView, SessionHarnesses } from '@litch/core'

export interface HarnessChoice {
  id: string
  name: string
  /** 两字母徽标，和会话行上的一样 */
  badge: string
}

type Devices = readonly (DeviceView | undefined)[]

const choiceOf = (devices: Devices, id: string, onlineOnly: boolean): HarnessChoice | null => {
  for (const device of devices) {
    if (!device || (onlineOnly && device.connection !== 'online')) continue
    const harness = device.harnesses.find((entry) => entry.id === id)
    if (harness) return { id, name: harness.name, badge: harness.badge }
  }
  return null
}

/**
 * 能挑的 harness：连着的设备上声明的那些，同一个只出一次，按设备的先后、设备里声明的先后排。
 * 没连着的设备不算：它上面的会话是上次留下的，哪天连上了自然就算进来。
 * 一共不到两个就没什么可挑的，入口不该出现
 */
export function harnessChoices(devices: Devices): HarnessChoice[] {
  const seen = new Set<string>()
  const choices: HarnessChoice[] = []
  for (const device of devices) {
    if (device?.connection !== 'online') continue
    for (const harness of device.harnesses) {
      if (seen.has(harness.id)) continue
      seen.add(harness.id)
      choices.push({ id: harness.id, name: harness.name, badge: harness.badge })
    }
  }
  return choices
}

/**
 * 正筛着的那个 harness 怎么称呼。先在连着的设备里找，再在没连着的里找（设备还在连、或者断了）；
 * 哪儿都没有就用它的标识：筛选开着就得说得出在筛什么，好让人取消
 */
export function describeHarness(devices: Devices, id: string): HarnessChoice {
  return (
    choiceOf(devices, id, true) ??
    choiceOf(devices, id, false) ?? { id, name: id, badge: id.slice(0, 2).toUpperCase() }
  )
}

/**
 * 筛选开着时一组里留哪些会话，先后不变。harness 是 null（没在筛）原样给回去。
 * always：不管属于谁都留着的，见 Sidebar.tsx（正选中的、停下来等人的）
 */
export function keepSessions(
  ids: readonly string[] | undefined,
  harness: string | null,
  harnessOf: SessionHarnesses | undefined,
  always: (sessionId: string) => boolean,
): readonly string[] {
  if (!ids) return []
  if (harness === null) return ids
  return ids.filter((id) => harnessOf?.[id] === harness || always(id))
}
