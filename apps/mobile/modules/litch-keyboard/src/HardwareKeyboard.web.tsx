import { View } from 'react-native'
import type { HardwareKeyboardProps } from './HardwareKeyboard'

export function HardwareKeyboard({ submitEnabled, onSubmit, ...props }: HardwareKeyboardProps) {
  return (
    <View
      {...props}
      {...{
        onKeyDown: (event: {
          key: string
          shiftKey: boolean
          ctrlKey: boolean
          altKey: boolean
          metaKey: boolean
          isComposing: boolean
          nativeEvent?: { isComposing?: boolean }
          preventDefault(): void
        }) => {
          if (
            submitEnabled &&
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.isComposing &&
            !event.nativeEvent?.isComposing
          ) {
            event.preventDefault()
            onSubmit()
          }
        },
      }}
    />
  )
}
