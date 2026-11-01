// 控制台的排序是本机偏好：所有经理、所有类别共用一份，换窗口、重启后保留。
import { MANAGER_ISSUE_ORDERS, type ManagerIssueOrder, parseManagerIssueOrder } from '@litch/core'
import { useSyncExternalStore } from 'react'
import { useT } from '../app/appearance.ts'

const KEY = 'litch.managerIssueOrder'
function read(): ManagerIssueOrder {
  try {
    return parseManagerIssueOrder(localStorage.getItem(KEY))
  } catch {
    return parseManagerIssueOrder(null)
  }
}
let state = read()
const listeners = new Set<() => void>()
export function setIssueOrder(order: ManagerIssueOrder) {
  state = order
  try {
    localStorage.setItem(KEY, order)
  } catch {
    /* 不能持久化时仍在本窗口生效。 */
  }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const useIssueOrder = () => useSyncExternalStore(subscribe, () => state)

export function IssueOrderSelect() {
  const t = useT()
  const order = useIssueOrder()
  return (
    <label className="mg-issue-order">
      <span className="dim">{t('manager.order')}</span>
      <select
        data-act="manager-issue-order"
        value={order}
        onChange={(event) => setIssueOrder(parseManagerIssueOrder(event.target.value))}
      >
        {MANAGER_ISSUE_ORDERS.map((key) => (
          <option key={key} value={key}>
            {t(`manager.order.${key}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
