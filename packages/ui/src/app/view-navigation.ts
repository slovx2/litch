import type { PlaceWish } from '../composer/new-place.ts'
import type { Page, Selection } from './App.tsx'
import type { ManagersRoute } from './actions.ts'

export type ViewMode = 'chat' | 'manager'
interface ViewLocation {
  picked: Selection | null
  page: Page | null
  wish: PlaceWish | null
  peek?: Selection | null
  managersRoute?: ManagersRoute
}
export interface ViewNavigation {
  mode: ViewMode
  chat: ViewLocation
  manager: ViewLocation
}
export const initialNavigation: ViewNavigation = {
  mode: 'chat',
  chat: { picked: null, page: null, wish: null },
  manager: { picked: null, page: 'managers', wish: null },
}
export type NavigationAction =
  | { type: 'switch'; mode: ViewMode }
  | { type: 'select'; mode: ViewMode; selection: Selection }
  | { type: 'compose'; wish: PlaceWish | null }
  | { type: 'wish'; wish: PlaceWish | null }
  | { type: 'page'; page: Page | null; mode?: ViewMode; peek?: Selection | null }
  | { type: 'missing'; mode: ViewMode; selection: Selection }
  | { type: 'peek'; selection: Selection | null }
  | { type: 'managers'; route: ManagersRoute }

/** 经理不受点击入口所在模式影响；工作线仍可保留当前侧栏，正文始终是普通会话页。 */
export function sessionSelection(
  selection: Selection,
  managerId: string | null,
  mode?: ViewMode,
  managed = false,
): NavigationAction {
  return {
    type: 'select',
    mode: managerId ? 'manager' : (mode ?? (managed ? 'manager' : 'chat')),
    selection,
  }
}

/** 两种视图各自记住位置；切栏只换当前视图，不等同于新建或回到列表。 */
export function navigate(state: ViewNavigation, action: NavigationAction): ViewNavigation {
  const mode = 'mode' in action ? (action.mode ?? state.mode) : state.mode
  const location = state[mode]
  switch (action.type) {
    case 'peek':
      if ((location.peek ?? null) === action.selection) return state
      return { ...state, [mode]: { ...location, peek: action.selection } }
    case 'managers':
      return {
        ...state,
        mode: 'manager',
        manager: { ...state.manager, page: 'managers', managersRoute: action.route, peek: null },
      }
    case 'switch':
      return { ...state, mode }
    case 'select':
      return { ...state, mode, [mode]: { picked: action.selection, page: null, wish: null } }
    case 'compose':
      return { ...state, mode: 'chat', chat: { picked: null, page: null, wish: action.wish } }
    case 'wish':
      return { ...state, [mode]: { ...location, wish: action.wish } }
    case 'page':
      return {
        ...state,
        mode,
        [mode]: { ...location, page: action.page, peek: action.peek ?? null },
      }
    case 'missing':
      // 较早一次订阅的结果不能清掉后来选中的会话。
      if (location.picked !== action.selection) return state
      return {
        ...state,
        [mode]: {
          ...location,
          picked: null,
          ...(mode === 'manager' ? { managersRoute: { view: 'list' as const } } : {}),
          // 设备改连会清掉旧会话；独立页面仍要显示连接结果，只有会话页回到默认入口。
          page: location.page ?? (mode === 'manager' ? 'managers' : null),
        },
      }
  }
}
