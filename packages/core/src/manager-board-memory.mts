import type { ManagerObjectId } from './model-manager.mjs'

/** 与对话滚动位置一样，只在当前客户端会话内记忆，不写设备或持久化存储。 */
export type BoardPageMemory = { selected: ManagerObjectId | null; y: number }
type BoardMemory = {
  filters: Record<string, string>
  category: 'decision' | 'suggestion' | 'request' | 'report'
  items: boolean
  pages: Map<string, BoardPageMemory>
}
const managers = new Map<string, BoardMemory>()

export function managerBoardMemory(deviceId: string, managerId: string): BoardMemory {
  const key = JSON.stringify([deviceId, managerId])
  let memory = managers.get(key)
  if (!memory) {
    memory = { filters: {}, category: 'decision', items: false, pages: new Map() }
    managers.set(key, memory)
  }
  return memory
}

/** 一级页签、类别、状态和排序共同定位一个阅读位置。 */
export function boardPageMemory(memory: BoardMemory, tab: string, query = ''): BoardPageMemory {
  const key = JSON.stringify([tab, query])
  let page = memory.pages.get(key)
  if (!page) {
    page = { selected: null, y: 0 }
    memory.pages.set(key, page)
  }
  return page
}
