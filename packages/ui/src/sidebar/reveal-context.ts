import { createContext, useContext } from 'react'
import type { Selection } from '../app/App.tsx'

/** 只标记实际的会话行点击；同一行菜单里的派出、撤销归档仍按外部打开定位。 */
export const SidebarReveal = createContext<{
  request: Selection | null
  fromTree(selection: Selection): void
}>({ request: null, fromTree: () => {} })

export const useSidebarReveal = () => useContext(SidebarReveal)
