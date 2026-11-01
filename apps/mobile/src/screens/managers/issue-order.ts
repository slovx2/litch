// 控制台排序是手机本地偏好：所有经理、所有类别共用一份，存在应用文档目录。
import { type ManagerIssueOrder, parseManagerIssueOrder } from '@litch/core'
import { useSyncExternalStore } from 'react'
import { jsonFile } from '../../shell/json-file'

const file = jsonFile<{ order: ManagerIssueOrder }>('manager-issue-order.json')
let state: ManagerIssueOrder | null = null
const listeners = new Set<() => void>()
const current = () => {
  state ??= parseManagerIssueOrder(file.read()?.order)
  return state
}
export function setIssueOrder(order: ManagerIssueOrder) {
  state = order
  try {
    file.write({ order })
  } catch {
    /* 写不进去时仍在本次运行生效。 */
  }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const useIssueOrder = () => useSyncExternalStore(subscribe, current)
