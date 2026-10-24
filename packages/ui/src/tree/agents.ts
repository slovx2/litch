// 引擎自己的子代理（原生 codex 的 collabAgentToolCall 派出的子线程）的列表：昵称、角色、能不能输入。
// 子代理线程不进侧栏（核心那边就挡掉了），只从对话里的卡片、信息卡、右侧“后台任务”页进去
// （页上看哪一个记在 background/tab.ts，openAgent 也在那里）。问列表的钩子在 useAgentList.ts。
import type { AgentThreadView, CoreChannel } from '@litch/core'

export { openAgent } from '../background/tab.ts'

export const keyOf = (deviceId: string, parentId: string) => `${deviceId}:${parentId}`

/** 父会话 → 子代理列表。问过一次就留着，卡片上子代理的状态变了再问 */
export const lists = new Map<string, { list: AgentThreadView[]; at: number }>()
const asking = new Set<string>()
let version = 0
export const versionNow = () => version
const listeners = new Set<() => void>()

const publish = () => {
  version++
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 隔这么久以内问过的不再问（同一个父会话的几张卡片、信息卡都会要） */
const FRESH_MS = 5_000

export function ask(
  channel: CoreChannel,
  deviceId: string,
  parentId: string,
  force: boolean,
): void {
  const key = keyOf(deviceId, parentId)
  const had = lists.get(key)
  if (asking.has(key) || (!force && had && Date.now() - had.at < FRESH_MS)) return
  asking.add(key)
  channel
    .command('session.agents', { deviceId, sessionId: parentId })
    .then(({ agents }) => {
      lists.set(key, { list: agents, at: Date.now() })
      publish()
    })
    // 问不到（没连着、对面不支持按父会话列）：卡片上照样能点，只是没有昵称
    .catch(() => {})
    .finally(() => asking.delete(key))
}
