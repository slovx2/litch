// 输入框随内容长高。手机上多行输入框自己会长高，到 maxHeight 为止，这里不用做什么；
// 网页上（界面预览）的做法在 grow.web.ts
import type { RefObject } from 'react'
import type { TextInput, TextInputProps } from 'react-native'

export function useGrow(_input: RefObject<TextInput | null>, _text: string): TextInputProps {
  return {}
}
