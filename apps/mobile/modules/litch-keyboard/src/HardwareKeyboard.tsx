import { requireNativeViewManager } from 'expo-modules-core'
import type { ReactNode } from 'react'
import type { ViewProps } from 'react-native'

export interface HardwareKeyboardProps extends ViewProps {
  submitEnabled: boolean
  onSubmit(): void
  children: ReactNode
}
export const HardwareKeyboard = requireNativeViewManager<HardwareKeyboardProps>('LitchKeyboard')
