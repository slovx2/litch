import type { PlaceWish } from '../composer/new-place.ts'
import type { Page, Selection } from './App.tsx'

export type ViewMode = 'chat' | 'manager'
interface ViewLocation {
  picked: Selection | null
  page: Page | null
  wish: PlaceWish | null
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
  | { type: 'page'; page: Page | null; mode?: ViewMode }
  | { type: 'missing'; mode: ViewMode; selection: Selection }

/** 两种视图各自记住位置；切栏只换当前视图，不等同于新建或回到列表。 */
export function navigate(state: ViewNavigation, action: NavigationAction): ViewNavigation {
  const mode = 'mode' in action ? (action.mode ?? state.mode) : state.mode
  const location = state[mode]
  switch (action.type) {
    case 'switch':
      return { ...state, mode }
    case 'select':
      return { ...state, mode, [mode]: { picked: action.selection, page: null, wish: null } }
    case 'compose':
      return { ...state, mode: 'chat', chat: { picked: null, page: null, wish: action.wish } }
    case 'wish':
      return { ...state, [mode]: { ...location, wish: action.wish } }
    case 'page':
      return { ...state, mode, [mode]: { ...location, page: action.page } }
    case 'missing':
      // 较早一次订阅的结果不能清掉后来选中的会话。
      if (location.picked !== action.selection) return state
      return {
        ...state,
        [mode]: { ...location, picked: null, page: mode === 'manager' ? 'managers' : null },
      }
  }
}
