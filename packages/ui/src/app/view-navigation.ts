import type { PlaceWish } from '../composer/new-place.ts'
import type { ManagerPageLocation } from '../manager/ManagerPage.tsx'
import type { Page, Selection } from './App.tsx'
import type { ManagersRoute } from './actions.ts'

export type ViewMode = 'chat' | 'manager'
interface ViewLocation {
  picked: Selection | null
  page: Page | null
  wish: PlaceWish | null
  peek?: Selection | null
  managersRoute?: ManagersRoute
  managerPage?: { key: string; location: ManagerPageLocation }
}
export interface ViewNavigation {
  mode: ViewMode
  location: ViewLocation
}
export const initialNavigation: ViewNavigation = {
  mode: 'chat',
  location: { picked: null, page: null, wish: null },
}
export type NavigationAction =
  | { type: 'switch'; mode: ViewMode }
  | { type: 'select'; selection: Selection }
  | { type: 'compose'; wish: PlaceWish | null }
  | { type: 'manager-location'; key: string; location: ManagerPageLocation }
  | { type: 'wish'; wish: PlaceWish | null }
  | { type: 'page'; page: Page | null; peek?: Selection | null }
  | { type: 'missing'; selection: Selection }
  | { type: 'peek'; selection: Selection | null }
  | { type: 'managers'; route: ManagersRoute }

/** 两棵侧栏只是导航入口；主区域只有一个位置，切树不打开或关闭任何内容。 */
export function navigate(state: ViewNavigation, action: NavigationAction): ViewNavigation {
  const { location } = state
  switch (action.type) {
    case 'manager-location':
      return {
        ...state,
        location: { ...location, managerPage: { key: action.key, location: action.location } },
      }
    case 'peek':
      if ((location.peek ?? null) === action.selection) return state
      return { ...state, location: { ...location, peek: action.selection } }
    case 'managers':
      return {
        ...state,
        location: { ...location, page: 'managers', managersRoute: action.route, peek: null },
      }
    case 'switch':
      return { ...state, mode: action.mode }
    case 'select':
      return { ...state, location: { picked: action.selection, page: null, wish: null } }
    case 'compose':
      return { ...state, location: { picked: null, page: null, wish: action.wish } }
    case 'wish':
      return { ...state, location: { ...location, wish: action.wish } }
    case 'page':
      return {
        ...state,
        location: { ...location, page: action.page, peek: action.peek ?? null },
      }
    case 'missing':
      // 较早一次订阅的结果不能清掉后来选中的会话。
      if (location.picked !== action.selection) return state
      return {
        ...state,
        location: {
          ...location,
          picked: null,
          // 设备改连会清掉旧会话；独立页面仍要显示连接结果，只有会话页回到默认入口。
          page: location.page,
        },
      }
  }
}
