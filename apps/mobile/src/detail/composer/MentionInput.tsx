// 手机输入框里提到的会话画成片（逻辑和桌面共用 packages/ui/src/composer/mention-field.ts）。
// 字还是 @[标题]，发出去、存草稿都不变；片是套在嵌套 Text 上的样式：强调色加底色的 ＠标题，方括号缩到看不见。
// 手机输入框拦不住退格，只能看改完的字：删到片的一部分就整片删（chipEdit）；光标、选区挪出片（snapSelection）。
// 网页预览的输入框不认嵌套的 Text，照原文显示。
import { type ReactNode, type RefObject, useMemo, useRef } from 'react'
import { Platform, Text, type TextInput, type TextInputProps } from 'react-native'
import {
  chipEdit,
  type DraftMention,
  type MentionRange,
  mentionRanges,
  snapSelection,
} from '../../../../../packages/ui/src/composer/mention-field.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

/**
 * 给 TextInput 的属性和子元素。没有片时照常用 value；有片时字由子元素给。
 * onSelect 收挪好之后的光标（认 `@` 用）
 */
export function useMentionInput({
  input,
  text,
  setText,
  sessions,
  onSelect,
}: {
  input: RefObject<TextInput | null>
  text: string
  setText(text: string): void
  sessions: readonly DraftMention[]
  onSelect?(selection: { start: number; end: number }): void
}): { props: TextInputProps; children: ReactNode; ranges: MentionRange[] } {
  const t = useT()
  const ranges = useMemo(() => mentionRanges(text, sessions), [text, sessions])
  const chips = ranges.length > 0 && Platform.OS !== 'web'
  const selection = useRef<{ start: number; end: number } | null>(null)
  const props: TextInputProps = {
    ...(chips ? {} : { value: text }),
    onChangeText: (next) => {
      const fixed = chipEdit(text, next, ranges)
      if (!fixed) {
        setText(next)
        return
      }
      setText(fixed.text)
      selection.current = { start: fixed.caret, end: fixed.caret }
      onSelect?.(selection.current)
      requestAnimationFrame(() => input.current?.setSelection(fixed.caret, fixed.caret))
    },
    onSelectionChange: (event) => {
      const next = event.nativeEvent.selection
      const snapped = snapSelection(ranges, next, selection.current)
      selection.current = snapped ?? next
      onSelect?.(selection.current)
      if (snapped) input.current?.setSelection(snapped.start, snapped.end)
    },
    ...(ranges.length > 0
      ? {
          accessibilityHint: ranges
            .map((range) => t('mention.chip', { title: range.title }))
            .join(t('list.comma')),
        }
      : {}),
  }
  return { props, children: chips ? <ChipText text={text} ranges={ranges} /> : undefined, ranges }
}

function ChipText({ text, ranges }: { text: string; ranges: readonly MentionRange[] }) {
  const { c } = useTheme()
  const hidden = { fontSize: 1, color: 'transparent' } as const
  const parts: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start > at) parts.push(text.slice(at, range.start))
    parts.push(
      <Text
        key={`m${range.start}`}
        testID={`compose-mention-${range.threadId}`}
        style={{ color: c.accent, fontWeight: '600', backgroundColor: c.sel }}
      >
        @<Text style={hidden}>[</Text>
        {range.title}
        <Text style={hidden}>]</Text>
      </Text>,
    )
    at = range.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <Text>{parts}</Text>
}
