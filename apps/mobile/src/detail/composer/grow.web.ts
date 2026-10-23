// 网页上的多行输入框（textarea）不会自己长高，默认还是两行高：先定成一行，内容变了按内容量一次高度。
// 上限仍是样式里的 maxHeight，超过了才出滚动条
import { type RefObject, useLayoutEffect } from 'react'
import type { TextInput, TextInputProps } from 'react-native'

export function useGrow(input: RefObject<TextInput | null>, text: string): TextInputProps {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变了才重量
  useLayoutEffect(() => {
    const node = input.current as unknown as HTMLTextAreaElement | null
    if (!node) return
    const style = getComputedStyle(node)
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const max = parseFloat(style.maxHeight) || Number.POSITIVE_INFINITY
    node.style.height = 'auto'
    const want = node.scrollHeight + border
    node.style.height = `${Math.min(want, max)}px`
    node.style.overflowY = want > max ? 'auto' : 'hidden'
  }, [text])
  return { numberOfLines: 1 }
}
