import type { SessionChildren, SidebarProjectionRow } from '@litch/core'
import { createContext, useContext } from 'react'
import type { Selection } from '../app/App.tsx'
import type { RowSelection, RowSource } from './selection.ts'

/** 只标记实际的会话行点击；同一行菜单里的派出、撤销归档仍按外部打开定位。 */
export const SidebarReveal = createContext<{
  request: Selection | null
  selected: RowSelection | null
  fromTree(selection: Selection, source: RowSource): void
  checkProjection(
    kind: 'recent' | 'unread',
    rows: readonly SidebarProjectionRow[],
    children: SessionChildren,
  ): void
}>({ request: null, selected: null, fromTree: () => {}, checkProjection: () => {} })

export const useSidebarReveal = () => useContext(SidebarReveal)
