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

/**
 * 排序下拉，放在列表头那一行的右端。决策已按状态分开，组内“待处理优先”与“最新优先”结果一样，
 * 所以决策列表不给这一项（withPending=false），存着的“待处理优先”在那里显示为最新优先。
 */
export function IssueOrderSelect({ withPending = true }: { withPending?: boolean }) {
  const t = useT()
  const order = useIssueOrder()
  const choices = MANAGER_ISSUE_ORDERS.filter((key) => withPending || key !== 'pending')
  return (
    <label className="mg-issue-order">
      <span className="mg-issue-order-label">{t('manager.order')}</span>
      <select
        data-act="manager-issue-order"
        value={choices.includes(order) ? order : 'newest'}
        onChange={(event) => setIssueOrder(parseManagerIssueOrder(event.target.value))}
      >
        {choices.map((key) => (
          <option key={key} value={key}>
            {t(`manager.order.${key}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
