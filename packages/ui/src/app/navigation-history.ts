import { type History, visit, without } from './history.ts'
import {
  initialNavigation,
  type NavigationAction,
  navigate,
  type ViewNavigation,
} from './view-navigation.ts'

/** 只比较主区域的位置；切换左侧导航树不构成新的访问。 */
const locationKey = (state: ViewNavigation): string => {
  const { page, picked, wish, peek, managersRoute } = state.location
  return JSON.stringify([
    page,
    peek ? [peek.deviceId, peek.sessionId] : null,
    page
      ? page === 'managers'
        ? (managersRoute ?? { view: 'list' })
        : null
      : picked
        ? [picked.deviceId, picked.sessionId]
        : wish,
  ])
}
const same = (a: ViewNavigation, b: ViewNavigation): boolean => locationKey(a) === locationKey(b)

export function navigationHistory(
  was: History<ViewNavigation>,
  action: NavigationAction,
): History<ViewNavigation> {
  const current = was.entries[was.index] ?? initialNavigation
  const next = navigate(current, action)
  // 侧栏模式独立于内容历史；后退、前进也不切换导航树。
  if (action.type === 'switch')
    return { ...was, entries: was.entries.map((entry) => navigate(entry, action)) }
  if (action.type === 'missing') {
    const pruned = without(was, (entry) => {
      const location = entry.location
      return (
        !!location.page ||
        location.picked?.deviceId !== action.selection.deviceId ||
        location.picked.sessionId !== action.selection.sessionId
      )
    })
    return {
      ...pruned,
      entries: pruned.entries.map((entry) => {
        const picked = entry.location.picked
        return picked?.deviceId === action.selection.deviceId &&
          picked.sessionId === action.selection.sessionId
          ? navigate(entry, { ...action, selection: picked })
          : entry
      }),
    }
  }
  if (action.type === 'wish' || action.type === 'manager-location')
    return {
      ...was,
      entries: was.entries.map((entry, index) => (index === was.index ? next : entry)),
    }
  // 重开当前会话仍要重新定位（例如通知打开被手动折叠的当前行），但不增加历史项。
  if (action.type === 'select' && same(current, next))
    return { ...was, entries: was.entries.with(was.index, next) }
  return visit(was, next, same)
}
