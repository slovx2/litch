import { createContext, useContext } from 'react'
import type { Pane } from './tablet-layout'

export const PaneContext = createContext<{
  pane: Pane
  split: boolean
  visible: boolean
  width: number
  back(): void
} | null>(null)
export const usePane = () => useContext(PaneContext)
